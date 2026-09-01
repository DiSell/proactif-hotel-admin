import type { SupabaseClient } from "@supabase/supabase-js";
import type { PartnerRequest } from "@/features/partnerRequests/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createPartnerRequestForChatbot, applyPartnerRequestCommandForChatbot } from "@/features/partnerRequests/chatbotService";
import { getActivePartnerRequestForConversation, getGuestPhoneForPartnerRequest, getPartnerRequestById, hasGuestConfirmedEvent } from "@/features/partnerRequests/queries";
import { deliverPartnerRequest, getLatestPartnerRequestDelivery, reconcileStaleSendingDelivery } from "@/features/partnerRequests/deliveryService";
import { maskPhoneForDisplay } from "@/features/partnerRequests/phoneRedaction";
import { formatPartnerRequestDate, formatPartnerRequestTime } from "@/features/partnerRequests/presentation";
import { loadActiveHotelPartners } from "./partners";
import type { PendingPartnerRequestFields, PartnerRequestPhonePrompt, RagPartner } from "./types";
import { isExplicitConfirmation } from "./confirmation";

/**
 * Extracted to features/rag/confirmation.ts (domain-agnostic, reused by
 * features/rag/spaBookingFlow.ts) — re-exported here so this module's own
 * existing tests/call sites keep working unchanged.
 */
export { isExplicitConfirmation } from "./confirmation";

/**
 * KNOWN LIMITATION (free-text path only — see submitStructuredGuestPhone
 * below for the structured widget-form path that replaces this as the
 * PRIMARY collection mechanism) — the free-text safety net is NOT complete
 * multi-turn collection, only a same-turn one. If a visitor spontaneously
 * types their phone number in a message BEFORE the turn where every other
 * required field (partner/date/time/name...) is already known,
 * phoneRedaction.ts correctly redacts it from that message before it's
 * persisted to messages.content or sent to the model (confidentiality is
 * preserved), but the extracted E.164 value itself is NOT stored anywhere
 * for later reuse via THIS path — there is no new intermediate persistence
 * layer for the free-text path, and the raw number must never live outside
 * partner_requests.guest_phone_e164 itself. An earlier, "too soon" free-text
 * phone is effectively lost for that path; the visitor would need to give it
 * again once asked, OR use the structured form once it appears (see below),
 * which does not have this limitation — it carries the pending fields
 * forward explicitly via partnerRequestPhonePrompt.pendingRequest, echoed
 * back by the widget itself, not by re-scanning chat history.
 */

export interface PartnerRequestModelOutput {
  partnerRequestIntent: boolean;
  partnerId: string | null;
  requestedDate: string | null;
  requestedTime: string | null;
  partySize: number | null;
  details: string | null;
  guestName: string | null;
  needsGuestName: boolean;
  needsGuestPhone: boolean;
  confirmPartnerRequest: boolean;
}

export interface ProcessPartnerRequestTurnParams {
  hotelId: string;
  conversationId: string;
  /** Already redacted (see phoneRedaction.ts) — never the raw message. */
  message: string;
  /** Extracted from THIS turn's message only — never carried over from an earlier turn (nothing but partner_requests.guest_phone_e164 itself ever stores the raw digits, by design — see phoneRedaction.ts's own doc comment). */
  normalizedPhoneE164: string | null;
  activePartnerRequest: PartnerRequest | null;
  /** hotel_id-, is_active-, consent_status=accepted-scoped (features/rag/partners.ts:loadActiveHotelPartners) — the ONLY list a partnerId is ever validated against here. */
  allActivePartners: RagPartner[];
  modelOutput: PartnerRequestModelOutput;
  /** Forwarded to chatbotService — omit to use its own createAdminClient() default; tests inject a fake. */
  supabase?: SupabaseClient;
}

/** What processPartnerRequestTurn/submitStructuredGuestPhone hand back to their callers — never both fields meaningful at once (a phonePrompt turn never also has recap text to append). */
export interface PartnerRequestTurnOutcome {
  /** Text to APPEND to the model's own conversational reply, or null. */
  replySuffix: string | null;
  /** Non-null exactly when the widget must show the structured phone form — see features/rag/types.ts's own doc comment. */
  phonePrompt: PartnerRequestPhonePrompt | null;
  /** True only for post-confirmation delivery outcomes: the DB-derived status message replaces, rather than supplements, model prose. */
  replaceReply?: boolean;
}

const NO_OUTCOME: PartnerRequestTurnOutcome = { replySuffix: null, phonePrompt: null };

function buildRecapText(
  partner: RagPartner,
  fields: {
    requestedDate: string | null;
    requestedTime: string | null;
    partySize: number | null;
    details: string | null;
    guestName: string | null;
    maskedPhone: string | null;
  }
): string {
  const lines = [`Voici le récapitulatif de votre demande auprès de ${partner.name} :`, `- Partenaire : ${partner.name}`];
  if (fields.requestedDate) lines.push(`- Date : ${formatPartnerRequestDate(fields.requestedDate)}`);
  if (fields.requestedTime) lines.push(`- Heure : ${formatPartnerRequestTime(fields.requestedTime)}`);
  if (fields.partySize) lines.push(`- Nombre de personnes : ${fields.partySize}`);
  if (fields.details) lines.push(`- Détails : ${fields.details}`);
  if (fields.guestName) lines.push(`- Nom : ${fields.guestName}`);
  if (fields.maskedPhone) lines.push(`- Téléphone : ${fields.maskedPhone}`);
  lines.push(
    "",
    "Votre numéro sera utilisé uniquement pour transmettre cette demande et vous communiquer la réponse du partenaire.",
    "",
    "Cette demande est préparée et en attente d'envoi — elle n'a pas encore été transmise au partenaire.",
    "Souhaitez-vous envoyer cette demande ?"
  );
  return lines.join("\n");
}

export type PartnerDeliveryUserState = "sent" | "failed" | "unknown" | "in_progress" | "unavailable" | "ineligible";

export function buildPartnerDeliveryUserMessage(state: PartnerDeliveryUserState): string {
  switch (state) {
    case "sent":
      return "Votre demande a bien été transmise au partenaire. Nous attendons maintenant sa réponse.";
    case "failed":
      return "Votre demande est bien enregistrée, mais nous n’avons pas pu la transmettre au partenaire pour le moment.";
    case "unknown":
      return "Votre demande est enregistrée. La transmission est en cours de vérification.";
    case "in_progress":
      return "Votre demande est enregistrée. Sa transmission au partenaire est en cours.";
    case "unavailable":
      return "Votre demande est enregistrée, mais le service de transmission au partenaire n’est pas encore disponible.";
    case "ineligible":
      return "Ce partenaire ne peut pas recevoir de demande directement pour le moment.";
  }
}

function messageForSendResult(result: Awaited<ReturnType<typeof deliverPartnerRequest>>): PartnerDeliveryUserState {
  if (result.ok) return "sent";
  if (result.error === "provider_unknown") return "unknown";
  if (result.error === "provider_error") return "failed";
  if (result.error === "delivery_already_in_progress") return "in_progress";
  if (result.error === "provider_not_configured" || result.error === "template_not_configured") return "unavailable";
  return "ineligible";
}

function messageForPersistedDelivery(status: "queued" | "sending" | "sent" | "failed" | "unknown"): PartnerDeliveryUserState {
  if (status === "sent") return "sent";
  if (status === "failed") return "failed";
  if (status === "unknown") return "unknown";
  return "in_progress";
}

interface FinalizePartnerRequestCreationParams {
  hotelId: string;
  conversationId: string;
  partner: RagPartner;
  guestPhoneE164: string;
  requestedDate: string | null;
  requestedTime: string | null;
  partySize: number | null;
  details: string | null;
  guestName: string | null;
  supabase?: SupabaseClient;
}

/**
 * The ONLY place create_partner_request + request_guest_confirmation are
 * called together — shared by the free-text path (processPartnerRequestTurn
 * below) and the structured widget-form path (submitStructuredGuestPhone
 * below), so the two RPCs are never sequenced differently depending on
 * which collection path supplied the phone number.
 *
 * Handles the one race the 0021 unique-active-request index can surface
 * here: createPartnerRequestForChatbot already recovers from a 23505 by
 * reusing whatever request a CONCURRENT call created — but that concurrent
 * call may ALSO have already run request_guest_confirmation on it before
 * this call gets a chance to. Postgres then legitimately rejects a second,
 * redundant transition attempt ("not allowed from status
 * pending_confirmation"). Rather than treat that as a hard failure, the row
 * is re-read: if it already sits at pending_confirmation, the desired end
 * state was reached by the other call, so this proceeds to build the recap
 * normally. Anything else re-throws — never silently swallowed.
 */
async function finalizePartnerRequestCreation(params: FinalizePartnerRequestCreationParams): Promise<string> {
  const partnerRequestId = await createPartnerRequestForChatbot(
    {
      hotelId: params.hotelId,
      partnerId: params.partner.id,
      conversationId: params.conversationId,
      guestName: params.guestName,
      guestPhoneE164: params.guestPhoneE164,
      requestCategory: params.partner.category,
      requestedDate: params.requestedDate,
      requestedTime: params.requestedTime,
      partySize: params.partySize,
      details: params.details,
    },
    params.supabase
  );

  try {
    await applyPartnerRequestCommandForChatbot(partnerRequestId, params.hotelId, "request_guest_confirmation", params.supabase);
  } catch (err) {
    // getActivePartnerRequestForConversation (queries.ts) has no built-in
    // createAdminClient() default (its own file's convention requires an
    // explicit client always) — resolved here, lazily, only on this rare
    // error path, never eagerly for the (overwhelmingly common) success
    // path above.
    const supabaseForReread = params.supabase ?? createAdminClient();
    const current = await getActivePartnerRequestForConversation(params.hotelId, params.conversationId, supabaseForReread);
    const alreadyAdvancedByAConcurrentCall = current?.id === partnerRequestId && current.status === "pending_confirmation";
    if (!alreadyAdvancedByAConcurrentCall) throw err;
  }

  return buildRecapText(params.partner, {
    requestedDate: params.requestedDate,
    requestedTime: params.requestedTime,
    partySize: params.partySize,
    details: params.details,
    guestName: params.guestName,
    maskedPhone: maskPhoneForDisplay(params.guestPhoneE164),
  });
}

/**
 * The ONLY place a partner_request is created or advanced from a normal
 * chat turn. Never calls partner_delivery_succeeded/partner_delivery_failed
 * — structurally impossible, see ChatbotPartnerRequestCommand in
 * chatbotService.ts.
 */
export async function processPartnerRequestTurn(params: ProcessPartnerRequestTurnParams): Promise<PartnerRequestTurnOutcome> {
  const { hotelId, conversationId, message, normalizedPhoneE164, activePartnerRequest, allActivePartners, modelOutput, supabase } = params;

  if (activePartnerRequest) {
    if (activePartnerRequest.status === "draft") {
      // The two RPCs (create_partner_request / request_guest_confirmation)
      // are NOT atomic together — a prior turn may have created this row
      // and then failed (transient error, process restart) before
      // advancing it. Always safe to resume: this flow only ever calls
      // create_partner_request once all required fields (partner, dates,
      // name, phone) were already known — see the creation gate below — so
      // a found draft never needs anything re-collected, only the
      // transition retried. Uses the DB projection's OWN already-stored
      // fields, never the current turn's modelOutput, since those reflect
      // THIS turn's conversation state, not necessarily the draft's.
      const partner = allActivePartners.find((p) => p.id === activePartnerRequest.partner_id);
      if (!partner) return NO_OUTCOME; // partner deactivated/consent revoked since creation — left as-is, never guessed at

      await applyPartnerRequestCommandForChatbot(activePartnerRequest.id, hotelId, "request_guest_confirmation", supabase);
      return {
        replySuffix: buildRecapText(partner, {
          requestedDate: activePartnerRequest.requested_date,
          requestedTime: activePartnerRequest.requested_time,
          partySize: activePartnerRequest.party_size,
          details: activePartnerRequest.details,
          guestName: activePartnerRequest.guest_name,
          // guest_phone_e164 is deliberately excluded from the projection
          // getActivePartnerRequestForConversation reads (PII discipline —
          // see queries.ts) — a resumed draft's recap never repeats a phone
          // line. The number itself was already durably stored by the
          // original, successful create_partner_request call; it does not
          // need to be re-displayed to progress the state machine.
          maskedPhone: null,
        }),
        phonePrompt: null,
      };
    }

    if (activePartnerRequest.status === "sent_to_partner" && modelOutput.confirmPartnerRequest && isExplicitConfirmation(message)) {
      return { replySuffix: buildPartnerDeliveryUserMessage("sent"), phonePrompt: null, replaceReply: true };
    }

    if (activePartnerRequest.status !== "pending_confirmation") {
      // sent_to_partner/alternative_proposed: out of scope for this phase
      // (nothing transmits yet, so these can only exist via a manual
      // back-office action, never via this flow).
      return NO_OUTCOME;
    }
    // Always re-read from the DB projection, never assumed from a prior
    // turn's own memory: if a previous request_guest_confirmation call
    // actually succeeded server-side but its response was lost to the
    // caller, activePartnerRequest (freshly re-read every turn — see
    // answer.ts) already shows pending_confirmation here, so this branch —
    // never the draft-resume branch above — is what runs, and
    // request_guest_confirmation is never called a second, inconsistent
    // time for the same row.
    if (!modelOutput.confirmPartnerRequest || !isExplicitConfirmation(message)) return NO_OUTCOME;

    const serverSupabase = supabase ?? createAdminClient();
    const existingDelivery = await getLatestPartnerRequestDelivery(activePartnerRequest.id, hotelId, "initial_request", serverSupabase);
    const alreadyConfirmed = await hasGuestConfirmedEvent(activePartnerRequest.id, hotelId, serverSupabase);

    if (!alreadyConfirmed) {
      await applyPartnerRequestCommandForChatbot(activePartnerRequest.id, hotelId, "guest_confirm", serverSupabase);
    }

    const confirmedRequest = await getPartnerRequestById(hotelId, activePartnerRequest.id, serverSupabase);
    if (!confirmedRequest) return NO_OUTCOME;
    if (confirmedRequest.status === "sent_to_partner") {
      return { replySuffix: buildPartnerDeliveryUserMessage("sent"), phonePrompt: null, replaceReply: true };
    }
    if (confirmedRequest.status !== "pending_confirmation") return NO_OUTCOME;

    if (existingDelivery) {
      const status = await reconcileStaleSendingDelivery(existingDelivery, activePartnerRequest.id, hotelId, { supabase: serverSupabase });
      return { replySuffix: buildPartnerDeliveryUserMessage(messageForPersistedDelivery(status)), phonePrompt: null, replaceReply: true };
    }

    const deliveryResult = await deliverPartnerRequest(activePartnerRequest.id, hotelId, { supabase: serverSupabase });
    const finalRequest = await getPartnerRequestById(hotelId, activePartnerRequest.id, serverSupabase);
    let finalState = finalRequest?.status === "sent_to_partner" ? "sent" : messageForSendResult(deliveryResult);
    if (!deliveryResult.ok && deliveryResult.error === "delivery_already_in_progress") {
      const racedDelivery = await getLatestPartnerRequestDelivery(activePartnerRequest.id, hotelId, "initial_request", serverSupabase);
      if (racedDelivery) finalState = messageForPersistedDelivery(racedDelivery.status);
    }
    return { replySuffix: buildPartnerDeliveryUserMessage(finalState), phonePrompt: null, replaceReply: true };
  }

  if (!modelOutput.partnerRequestIntent || !modelOutput.partnerId) return NO_OUTCOME;
  if (modelOutput.needsGuestName) return NO_OUTCOME;

  // Revalidated against the exact, authoritative, tenant-scoped list — same
  // hotel_id/is_active/consent_status=accepted criteria as
  // buildPartnerRecommendations in answer.ts. An id the model invented, or
  // one that belongs to another hotel, or an inactive/non-consenting
  // partner, silently resolves to "not found", never trusted.
  const partner = allActivePartners.find((p) => p.id === modelOutput.partnerId);
  if (!partner) return NO_OUTCOME;

  // Free-text path: the phone must have been extracted from THIS turn's
  // message — there is nowhere else it could come from (see
  // phoneRedaction.ts: the raw digits never persist anywhere except
  // partner_requests.guest_phone_e164 itself, set exactly once, right
  // here). Checked BEFORE needsGuestPhone below so a visitor who types
  // their number can still complete the request in the same turn even if
  // the model also (correctly, from its own turn-start perspective) still
  // reports needsGuestPhone=true.
  if (normalizedPhoneE164) {
    const replySuffix = await finalizePartnerRequestCreation({
      hotelId,
      conversationId,
      partner,
      guestPhoneE164: normalizedPhoneE164,
      requestedDate: modelOutput.requestedDate,
      requestedTime: modelOutput.requestedTime,
      partySize: modelOutput.partySize,
      details: modelOutput.details,
      guestName: modelOutput.guestName,
      supabase,
    });
    return { replySuffix, phonePrompt: null };
  }

  if (!modelOutput.needsGuestPhone) return NO_OUTCOME; // model reports it doesn't need a phone yet but also didn't extract one this turn — nothing to do

  // Structured path: signal the widget to show the dedicated phone form
  // (see features/widget/PublicWidgetChat.tsx and
  // src/app/api/widget/[widgetKey]/partner-request/phone/route.ts) instead
  // of relying on free text. pendingRequest carries forward everything
  // already known so the phone-collection endpoint can create the request
  // in one shot once the number arrives — see submitStructuredGuestPhone.
  return {
    replySuffix: null,
    phonePrompt: {
      partnerName: partner.name,
      pendingRequest: {
        partnerId: partner.id,
        requestedDate: modelOutput.requestedDate,
        requestedTime: modelOutput.requestedTime,
        partySize: modelOutput.partySize,
        details: modelOutput.details,
        guestName: modelOutput.guestName,
      },
    },
  };
}

export interface SubmitStructuredGuestPhoneParams {
  hotelId: string;
  conversationId: string;
  /** Already normalized to E.164 by the caller (route.ts) — see phoneRedaction.ts:normalizeStructuredPhoneInput. */
  phoneE164: string;
  /** Echoed back by the widget from the phonePrompt it was shown — never trusted as-is: partnerId is revalidated here exactly like every other model-sourced id in this codebase. */
  pendingRequest: PendingPartnerRequestFields;
  supabase: SupabaseClient;
}

export type SubmitStructuredGuestPhoneResult =
  | { ok: true; message: string }
  | { ok: false; code: "partner_unavailable" | "phone_mismatch" | "unsupported_state"; error: string };

/**
 * The ONLY place the structured widget phone form's submission is
 * processed. Idempotent by design (see 0021_partner_requests_active_idempotency.sql
 * and createPartnerRequestForChatbot's own 23505 recovery): a double
 * click/network retry submitting the SAME phone for the SAME conversation
 * never creates a second partner_request or a second event — see this
 * function's own branches below for exactly how each case (no request yet /
 * draft / pending_confirmation / a genuinely different phone) is handled.
 */
export async function submitStructuredGuestPhone(params: SubmitStructuredGuestPhoneParams): Promise<SubmitStructuredGuestPhoneResult> {
  const { hotelId, conversationId, phoneE164, pendingRequest, supabase } = params;

  const active = await getActivePartnerRequestForConversation(hotelId, conversationId, supabase);

  if (active) {
    if (active.status !== "draft" && active.status !== "pending_confirmation") {
      // sent_to_partner/alternative_proposed/terminal: out of scope for
      // this phase — a phone submission has nothing legitimate to do here.
      return { ok: false, code: "unsupported_state", error: "Cette demande ne peut plus recevoir de numéro de téléphone." };
    }

    // Narrow, justified PII read (see queries.ts's own doc comment on this
    // function) — used ONLY for this idempotency comparison, never logged,
    // never returned to the caller.
    const storedPhone = await getGuestPhoneForPartnerRequest(hotelId, active.id, supabase);
    if (storedPhone !== phoneE164) {
      // Never a silent overwrite: no RPC exists to update guest_phone_e164
      // on an already-created request (0020_partner_requests.sql has no
      // such path, by design), and even if one did, guessing which value
      // is "correct" between two different submissions is not this
      // function's call to make.
      return {
        ok: false,
        code: "phone_mismatch",
        error: "Un numéro différent a déjà été enregistré pour cette demande. Contactez l'établissement pour le modifier.",
      };
    }

    // Same value already stored — idempotent: a double click/retry must
    // never re-create anything or fail.
    if (active.status === "pending_confirmation") {
      return { ok: true, message: "Votre numéro a déjà été enregistré pour cette demande." };
    }

    // status === "draft": the SAME phone was already durably stored by an
    // earlier attempt, but request_guest_confirmation apparently didn't
    // complete yet (or this is a concurrent retry of the same submission)
    // — resume exactly like processPartnerRequestTurn's own draft-resume
    // branch, from the DB projection's own stored fields.
    const partner = (await loadActiveHotelPartners(supabase, hotelId)).find((p) => p.id === active.partner_id);
    if (!partner) return { ok: false, code: "partner_unavailable", error: "Ce partenaire n'est plus disponible." };

    try {
      await applyPartnerRequestCommandForChatbot(active.id, hotelId, "request_guest_confirmation", supabase);
    } catch (err) {
      const current = await getActivePartnerRequestForConversation(hotelId, conversationId, supabase);
      const alreadyAdvanced = current?.id === active.id && current.status === "pending_confirmation";
      if (!alreadyAdvanced) throw err;
    }

    return {
      ok: true,
      message: buildRecapText(partner, {
        requestedDate: active.requested_date,
        requestedTime: active.requested_time,
        partySize: active.party_size,
        details: active.details,
        guestName: active.guest_name,
        maskedPhone: maskPhoneForDisplay(phoneE164),
      }),
    };
  }

  // No active request yet — the happy path: create it now, phone included
  // from the very first write, exactly once.
  const partner = (await loadActiveHotelPartners(supabase, hotelId)).find((p) => p.id === pendingRequest.partnerId);
  if (!partner) return { ok: false, code: "partner_unavailable", error: "Ce partenaire n'est plus disponible." };

  const message = await finalizePartnerRequestCreation({
    hotelId,
    conversationId,
    partner,
    guestPhoneE164: phoneE164,
    requestedDate: pendingRequest.requestedDate,
    requestedTime: pendingRequest.requestedTime,
    partySize: pendingRequest.partySize,
    details: pendingRequest.details,
    guestName: pendingRequest.guestName,
    supabase,
  });

  return { ok: true, message };
}
