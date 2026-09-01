import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOpenAIClient } from "@/lib/openai/client";
import { openaiChatModel } from "@/lib/openai/env";
import { createSpaBookingForChatbot, type CreateSpaBookingResult, type SpaAvailability } from "@/features/spa/booking";
import type { PendingSpaBookingFields, SpaBookingPhonePrompt } from "./types";

/**
 * Conversational orchestrator for spa bookings — modeled on
 * partnerRequestFlow.ts, but DELIBERATELY diverges from it in two ways
 * required by the product decisions this feature was built against (see the
 * plan): (1) no accept/reject negotiation — a booking is auto-confirmed the
 * instant it's created; (2) no persisted "in-progress" row (no draft/
 * pending_confirmation state machine) — accepted trade-off, see
 * lastAssistantMessageContinuesSpaBooking below for how a multi-turn
 * collection is still tracked without one.
 *
 * A THIRD, structural divergence, discovered during implementation rather
 * than anticipated in the plan: partner_requests can ask "voulez-vous
 * envoyer ?" as a SEPARATE turn after the phone is known, because the phone
 * is already durably persisted in the draft row by then. Spa bookings have
 * no such row — phoneRedaction.ts's raw digits are NEVER stored anywhere
 * except the instant they're used, by design (see that module's own doc
 * comment) — so a phone given in turn N is gone by turn N+1, and a
 * separate "oui" one turn later would arrive with no phone number left to
 * act on. The fix: the recap explicitly asks the guest to PROVIDE THEIR
 * PHONE NUMBER to confirm — supplying it (whether typed directly or via the
 * structured widget form) is itself the guest's one deliberate, explicit
 * confirming act, and the booking is created in the SAME turn/request that
 * receives it. There is no separate "répondez oui" step for spa bookings.
 */

const SPA_INTENT_PATTERNS: RegExp[] = [
  /\bspa\b/i,
  /\bhammam\b/i,
  /\bsauna\b/i,
  /\bbains?\s+[àa]\s+remous\b/i,
  /\bmassages?\b/i,
  /\bsoins?\s+(?:corporels?|du\s+corps)\b/i,
  /\bcr[ée]neau\b/i,
];

/** Cheap keyword gate — mirrors isPartnerIntent/isBookingIntent's own role: decides whether the (costlier) extraction call below is worth running THIS turn, and contributes to spaBookingFlowActive in answer.ts. False negatives just mean the guest needs slightly more explicit wording; never a correctness issue. */
export function isSpaBookingIntent(message: string): boolean {
  return SPA_INTENT_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Invisible marker (8x U+2063 INVISIBLE SEPARATOR) appended to the
 * assistant's persisted message whenever a spa-booking collection is still
 * in progress — NEVER visible to the guest in any renderer (these code
 * points have zero width, unlike an HTML comment or a bracketed tag, which
 * would show up as literal text in a plain-text chat bubble). This is the
 * ENTIRE mechanism that lets a later, keyword-free reply ("2 personnes",
 * "demain", a bare phone number) still be recognized as continuing an
 * active spa-booking conversation — see lastAssistantMessageContinuesSpaBooking.
 * A false negative here (e.g. the guest closes and reopens the widget) just
 * means they're asked to restate their request — an accepted, deliberate
 * trade-off (see this module's own header comment), never a data-integrity
 * or security concern, since this marker is purely a conversational-state
 * heuristic, never an authorization mechanism.
 */
const SPA_RECAP_MARKER = "⁣".repeat(8);

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Finds the MOST RECENT assistant message in history and checks whether it
 * carries the marker. `history` here is exactly answer.ts's own
 * `historyInput` (loaded via loadHistory AFTER the current user message was
 * already persisted — see answer.ts::answerQuestion), so the current turn's
 * own message is always the last entry and is naturally skipped by scanning
 * backwards for the first "assistant" role.
 */
export function lastAssistantMessageContinuesSpaBooking(history: HistoryMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content.includes(SPA_RECAP_MARKER);
  }
  return false;
}

/** Appends the invisible continuation marker — the ONLY place it's ever written. */
export function withSpaContinuationMarker(reply: string): string {
  return `${reply}\n${SPA_RECAP_MARKER}`;
}

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const TIME_FORMAT = /^\d{2}:\d{2}$/;

export interface SpaBookingRequestState {
  bookingDate: string | null;
  slotStart: string | null;
  partySize: number | null;
}

const spaBookingRequestStateSchema = z.object({
  bookingDate: z.string().nullable(),
  slotStart: z.string().nullable(),
  partySize: z.number().int().nullable(),
});

function buildSpaExtractionInstructions(referenceDate: string): string {
  return [
    "Tu extrais l'état COURANT d'une demande de réservation spa à partir d'une conversation — tu ne réponds PAS au visiteur, tu structures uniquement ce qui est déjà connu.",
    `Date de référence ("aujourd'hui") : ${referenceDate}. Résous toute date relative ("demain", "ce week-end", "vendredi prochain") à partir de cette date de référence.`,
    "Produis la date au format ISO YYYY-MM-DD, et le créneau au format HH:MM (heure de début uniquement) — n'invente JAMAIS l'un ou l'autre si le texte ne le détermine pas avec confiance : laisse le champ à null.",
    "IMPORTANT — les messages ASSISTANT sont du CONTEXTE, jamais un fait acquis pour le VISITEUR : si l'assistant a proposé une date ou un créneau, ne le retiens dans l'état QUE si le visiteur l'a ensuite confirmé ou corrigé clairement dans un message ultérieur.",
    "partySize est le nombre de personnes pour la séance — ne devine jamais une valeur non exprimée dans la conversation.",
  ].join("\n");
}

/**
 * The only probabilistic step in this pipeline — mirrors
 * features/availability/extractStayRequest.ts::resolveStayRequestFromHistory
 * exactly (one responses.parse call resolves the CURRENT state directly
 * from history, no persistence). Its output MUST be passed through
 * validateSpaBookingRequestState before use anywhere.
 */
export async function resolveSpaBookingRequestFromHistory(messages: HistoryMessage[], referenceDate: string): Promise<SpaBookingRequestState> {
  const client = getOpenAIClient();
  const model = openaiChatModel();

  const response = await client.responses.parse({
    model,
    instructions: buildSpaExtractionInstructions(referenceDate),
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    text: { format: zodTextFormat(spaBookingRequestStateSchema, "spa_booking_request_state") },
  });

  if (!response.output_parsed) {
    throw new Error("resolveSpaBookingRequestFromHistory: response did not match the expected structured schema");
  }
  return response.output_parsed;
}

/** Deterministic sanity pass — nulls out anything malformed rather than trusting the model's own formatting. Never validates business rules (hours/capacity/advance window) — that stays exclusively the create_spa_booking() RPC's job. */
export function validateSpaBookingRequestState(raw: SpaBookingRequestState): SpaBookingRequestState {
  return {
    bookingDate: raw.bookingDate && DATE_FORMAT.test(raw.bookingDate) ? raw.bookingDate : null,
    slotStart: raw.slotStart && TIME_FORMAT.test(raw.slotStart) ? raw.slotStart : null,
    partySize: raw.partySize && raw.partySize > 0 ? raw.partySize : null,
  };
}

/**
 * Minimal extension for the spa-booking flow — deliberately EXCLUDES
 * bookingDate/slotStart/partySize (unlike PartnerRequestModelOutput's own
 * requestedDate/requestedTime/partySize, which are free text never checked
 * against a real calendar): those three fields come EXCLUSIVELY from
 * resolveSpaBookingRequestFromHistory + validateSpaBookingRequestState
 * above, so the main model can never fabricate a date/slot the guest didn't
 * actually state, and can never bypass the real capacity check. Also
 * deliberately never includes a phone field — same reasoning as
 * PartnerRequestModelOutput.
 */
export interface SpaBookingModelOutput {
  spaBookingIntent: boolean;
  /**
   * Deliberately named distinctly from PartnerRequestModelOutput's own
   * guestName/needsGuestName/needsGuestPhone fields — both sets are spread
   * into the SAME per-turn OpenAI structured-output schema (see answer.ts),
   * and giving them distinct names avoids any ambiguity about which flow a
   * field belongs to, even though the two flows never run their apply logic
   * the same turn.
   */
  spaGuestName: string | null;
  needsSpaGuestName: boolean;
  needsSpaGuestPhone: boolean;
  isNonResident: boolean;
  notes: string | null;
}

function formatBookingDateForRecap(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "full" });
}

function buildSpaRecapAwaitingPhone(fields: {
  bookingDate: string;
  slotStart: string;
  slotEnd: string;
  partySize: number;
  guestName: string | null;
  isNonResident: boolean;
  pricePerPerson: number | null;
}): string {
  const lines = ["Voici le récapitulatif de votre réservation spa :", `- Date : ${formatBookingDateForRecap(fields.bookingDate)}`, `- Créneau : ${fields.slotStart} - ${fields.slotEnd}`, `- Nombre de personnes : ${fields.partySize}`];
  if (fields.guestName) lines.push(`- Nom : ${fields.guestName}`);
  if (fields.isNonResident) lines.push("- Vous avez indiqué ne pas être client résident de l'établissement.");
  if (fields.pricePerPerson !== null) {
    lines.push(`- Prix estimé : ${(fields.pricePerPerson * fields.partySize).toFixed(2)} € (${fields.pricePerPerson.toFixed(2)} €/personne)`);
  }
  lines.push(
    "",
    "Aucun paiement n'est demandé à ce stade.",
    "Cette réservation n'est PAS encore enregistrée : en communiquant votre numéro de téléphone ci-dessous, vous confirmez définitivement cette réservation."
  );
  return lines.join("\n");
}

function buildSpaBookingResultMessage(result: CreateSpaBookingResult, slotStart: string, slotEnd: string, availability: SpaAvailability): string {
  if (result.ok) {
    return `Votre réservation spa est confirmée pour le créneau ${slotStart} - ${slotEnd}. L'établissement a été informé de votre venue.`;
  }
  switch (result.code) {
    case "slot_full": {
      const alternatives = availability.slots.filter((s) => s.bookable).map((s) => `${s.slotStart} - ${s.slotEnd}`);
      return alternatives.length > 0
        ? `Ce créneau vient malheureusement d'être complet. Créneaux encore disponibles ce jour-là : ${alternatives.join(", ")}. Lequel préférez-vous ?`
        : "Ce créneau vient malheureusement d'être complet, et aucun autre créneau n'est disponible ce jour-là. Souhaitez-vous essayer une autre date ?";
    }
    case "outside_window":
      return "Cette date n'est pas réservable pour le moment (trop éloignée). Merci de choisir une date plus proche.";
    case "min_notice":
      return "Ce créneau est trop proche pour être réservé maintenant. Merci de choisir un créneau plus tard, ou une autre date.";
    case "invalid_slot":
      return "Ce créneau ne correspond pas aux horaires d'ouverture du spa. Merci d'en choisir un autre.";
    case "non_resident_not_allowed":
      return "Cet établissement réserve actuellement l'accès au spa à ses clients résidents. N'hésitez pas à contacter la réception pour plus d'informations.";
    case "not_enabled":
      return "La réservation en ligne du spa n'est pas disponible pour le moment. N'hésitez pas à contacter directement l'établissement.";
    default:
      return "Une erreur est survenue lors de l'enregistrement de votre réservation. Merci de réessayer dans un instant, ou de contacter l'établissement directement.";
  }
}

export interface ProcessSpaBookingTurnParams {
  hotelId: string;
  conversationId: string;
  /** Already redacted (see phoneRedaction.ts) — never the raw message. */
  message: string;
  /** Extracted from THIS turn's message only — never carried over from an earlier turn, same discipline as partnerRequestFlow.ts. */
  normalizedPhoneE164: string | null;
  /** Computed by answer.ts for resolvedRequest.bookingDate (or today, if no date resolved yet) via features/spa/booking.ts:getSpaAvailability — never recomputed here. */
  availability: SpaAvailability;
  /** Already run through validateSpaBookingRequestState by answer.ts. */
  resolvedRequest: SpaBookingRequestState;
  modelOutput: SpaBookingModelOutput;
  supabase?: SupabaseClient;
}

export interface SpaBookingTurnOutcome {
  /** Text to APPEND to the model's own conversational reply, or null. */
  replySuffix: string | null;
  /** Non-null exactly when the widget must show the structured phone form. */
  phonePrompt: SpaBookingPhonePrompt | null;
  /** True only once a booking outcome (success or a terminal-ish failure message) replaces the model's own reply entirely. */
  replaceReply?: boolean;
  /** Whether the NEXT assistant reply should still carry the continuation marker — false once this exchange is genuinely finished (a real booking succeeded), true while still collecting or after a recoverable failure the guest can retry. */
  continuesFlow: boolean;
}

const NO_OUTCOME: SpaBookingTurnOutcome = { replySuffix: null, phonePrompt: null, continuesFlow: false };

/**
 * The ONLY place a spa_bookings row is ever created from a chat turn. See
 * this module's own header comment for why there is no separate
 * "confirmez-vous ?" step: providing the phone number (free text or via the
 * structured widget form) IS the guest's explicit confirming act, and the
 * booking is created in that same request.
 */
export async function processSpaBookingTurn(params: ProcessSpaBookingTurnParams): Promise<SpaBookingTurnOutcome> {
  const { hotelId, conversationId, normalizedPhoneE164, availability, resolvedRequest, modelOutput, supabase } = params;

  if (!availability.enabled) return NO_OUTCOME;

  const { bookingDate, partySize } = resolvedRequest;
  // Only trust a slotStart that matches a REAL slot boundary for the
  // resolved date — a value the extraction step hallucinated (or one that
  // no longer exists after a settings change) is treated as "not chosen
  // yet" rather than passed through to the RPC, which would just reject it
  // as invalid_slot anyway; catching it here lets the guidance re-list the
  // real options immediately instead of burning a failed booking attempt.
  const matchedSlot = resolvedRequest.slotStart ? availability.slots.find((s) => s.slotStart === resolvedRequest.slotStart) : undefined;
  const slotStart = matchedSlot?.slotStart ?? null;
  const slotEnd = matchedSlot?.slotEnd ?? null;

  if (!bookingDate || !slotStart || !slotEnd || !partySize) {
    // Still collecting date/slot/party size — the model's own reply
    // (guided by buildSpaBookingGuidance/buildSpaAvailabilityGuidance in
    // prompt.ts) already asks for what's missing; nothing to append here.
    return { replySuffix: null, phonePrompt: null, continuesFlow: true };
  }

  if (modelOutput.needsSpaGuestName && !modelOutput.spaGuestName) {
    return { replySuffix: null, phonePrompt: null, continuesFlow: true };
  }
  const guestName = modelOutput.spaGuestName;

  // Free-text path: a phone extracted from THIS turn's message finalizes
  // the booking immediately — checked before the structured-form fallback,
  // same precedence as processPartnerRequestTurn's own free-text-first rule.
  if (normalizedPhoneE164) {
    const result = await createSpaBookingForChatbot(
      {
        hotelId,
        conversationId,
        guestName,
        guestPhoneE164: normalizedPhoneE164,
        partySize,
        isNonResident: modelOutput.isNonResident,
        notes: modelOutput.notes,
        bookingDate,
        slotStart,
      },
      supabase
    );
    return {
      replySuffix: buildSpaBookingResultMessage(result, slotStart, slotEnd, availability),
      phonePrompt: null,
      replaceReply: true,
      continuesFlow: !result.ok,
    };
  }

  // Everything except the phone is known — show the deterministic recap and
  // signal the widget to render the structured phone form (see
  // features/rag/types.ts:SpaBookingPhonePrompt and
  // submitStructuredSpaBookingPhone below).
  return {
    replySuffix: buildSpaRecapAwaitingPhone({
      bookingDate,
      slotStart,
      slotEnd,
      partySize,
      guestName,
      isNonResident: modelOutput.isNonResident,
      pricePerPerson: availability.pricePerPerson,
    }),
    phonePrompt: {
      pendingBooking: {
        bookingDate,
        slotStart,
        partySize,
        guestName,
        isNonResident: modelOutput.isNonResident,
        notes: modelOutput.notes,
      },
    },
    continuesFlow: true,
  };
}

export type SubmitStructuredSpaBookingPhoneResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * The structured widget phone form's own submission handler — mirrors
 * submitStructuredGuestPhone (partnerRequestFlow.ts), but simpler: there is
 * no draft row to resume or compare against (no persistence — see this
 * module's header comment), so this always attempts to create the booking
 * directly. createSpaBookingForChatbot's own idempotency recovery (23505 on
 * spa_bookings_active_slot_per_conversation_idx) already makes a double
 * submit/network retry safe without any extra logic here.
 */
export async function submitStructuredSpaBookingPhone(params: {
  hotelId: string;
  conversationId: string;
  phoneE164: string;
  pendingBooking: PendingSpaBookingFields;
  availability: SpaAvailability;
  supabase: SupabaseClient;
}): Promise<SubmitStructuredSpaBookingPhoneResult> {
  const { hotelId, conversationId, phoneE164, pendingBooking, availability, supabase } = params;

  const matchedSlot = availability.slots.find((s) => s.slotStart === pendingBooking.slotStart);
  if (!availability.enabled || !matchedSlot) {
    return { ok: false, error: "Ce créneau n'est plus disponible. Merci de recommencer votre demande." };
  }

  const result = await createSpaBookingForChatbot(
    {
      hotelId,
      conversationId,
      guestName: pendingBooking.guestName,
      guestPhoneE164: phoneE164,
      partySize: pendingBooking.partySize,
      isNonResident: pendingBooking.isNonResident,
      notes: pendingBooking.notes,
      bookingDate: pendingBooking.bookingDate,
      slotStart: pendingBooking.slotStart,
    },
    supabase
  );

  return { ok: true, message: buildSpaBookingResultMessage(result, matchedSlot.slotStart, matchedSlot.slotEnd, availability) };
}
