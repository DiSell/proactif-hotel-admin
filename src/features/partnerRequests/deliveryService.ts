import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  prepareWhatsAppPartnerRequest,
  sendPreparedPartnerRequestTemplate,
  type PrepareWhatsAppPartnerRequestDeps,
  type SendPreparedPartnerRequestDeps,
} from "@/lib/notifications/whatsapp/sendPartnerRequest";
import { generatePartnerReplyTokenSet, hashPartnerReplyToken } from "@/lib/notifications/whatsapp/replyToken";
import type { WhatsAppSendResult } from "@/lib/notifications/whatsapp/types";
import { getConfiguredWhatsAppProvider } from "@/lib/notifications/whatsapp/provider";
import {
  prepareSmsPartnerRequest,
  sendPreparedPartnerRequestSms,
  type PrepareSmsPartnerRequestDeps,
  type SendPreparedPartnerRequestSmsDeps,
  type SmsPartnerRequestPreSendError,
} from "@/lib/notifications/sms/sendPartnerRequestSms";
import { generateSmsReplyCode, hashSmsReplyCode } from "@/lib/notifications/sms/smsReplyCode";
import { parseInboundSmsBody } from "@/lib/notifications/sms/inboundParsing";
import { getConfiguredSmsProvider } from "@/lib/notifications/sms/provider";
import type { SmsSendResult } from "@/lib/notifications/sms/types";
import { redactPhoneNumbers } from "./phoneRedaction";
import type { PartnerReplyCommand, PartnerRequestDeliveryPurpose, PartnerRequestDeliveryStatus } from "./types";

/**
 * Adapted to use partner_request_deliveries (0023_partner_request_deliveries.sql)
 * for BOTH durable delivery-attempt tracking and opaque reply-token
 * correlation — replacing the earlier design where reply tokens
 * self-encoded (HMAC-signed but NOT encrypted, therefore not confidential)
 * partnerRequestId/hotelId/command directly.
 *
 * Server-side orchestrator. processPartnerRequestTurn invokes
 * deliverPartnerRequest only after an explicit guest confirmation has been
 * persisted and re-read. It is never called by a Client Component or a
 * browser-selected status.
 *
 * Deliberately separate from features/partnerRequests/chatbotService.ts:
 * that file is structurally incapable of calling
 * partner_delivery_succeeded/partner_delivery_failed/partner_delivery_ambiguous
 * (see its own ChatbotPartnerRequestCommand type) — this is the ONLY place
 * those three commands are ever issued, and it is reachable only from the
 * notification layer, never from a guest-facing chat turn.
 */

const PROVIDER_NAME = "meta"; // the only WhatsAppProvider implemented so far (metaProvider.ts).
/** PHASE 2 — Twilio SMS transport (src/lib/notifications/sms/), see deliverPartnerRequestViaSms/resolvePartnerReplySms below. */
const PROVIDER_NAME_SMS = "twilio_sms";

function resolveSupabase(supabase: SupabaseClient | undefined): SupabaseClient {
  return supabase ?? createAdminClient();
}

/** Thrown by createDelivery() ONLY for the one error the caller must handle specially — every other RPC failure propagates as a generic Error, matching every other RPC wrapper in this codebase (chatbotService.ts, actions.ts). */
class DeliveryAlreadyInProgressError extends Error {}

/** `provider` is an explicit parameter (not read from a module const) so this single function serves both transports — create_partner_request_delivery's own RPC has always taken `p_provider` as a plain string, unrelated to which hash columns get populated later by start_*. WhatsApp's own call site (deliverPartnerRequest below) passes PROVIDER_NAME exactly as before — zero behavior change. */
async function createDelivery(hotelId: string, partnerRequestId: string, purpose: string, provider: string, supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("create_partner_request_delivery", {
    p_hotel_id: hotelId,
    p_partner_request_id: partnerRequestId,
    p_provider: provider,
    p_purpose: purpose,
  });
  if (error) {
    // 23505 = the partial unique index on (hotel_id, partner_request_id,
    // purpose) WHERE status IN active states (0023's own
    // partner_request_deliveries_active_purpose_key) — another attempt for
    // this exact request+purpose is already queued/sending/sent/unknown.
    // Never treated as a generic failure: this is the concurrency guard
    // (task section 12) doing exactly its job.
    if (error.code === "23505") throw new DeliveryAlreadyInProgressError();
    throw new Error(error.message);
  }
  return data as string;
}

async function startDelivery(
  deliveryId: string,
  hotelId: string,
  tokenHashes: { accept: string; reject: string; alternative: string },
  supabase: SupabaseClient
): Promise<void> {
  const { error } = await supabase.rpc("start_partner_request_delivery", {
    p_delivery_id: deliveryId,
    p_hotel_id: hotelId,
    p_accept_token_hash: tokenHashes.accept,
    p_reject_token_hash: tokenHashes.reject,
    p_propose_alternative_token_hash: tokenHashes.alternative,
  });
  if (error) throw new Error(error.message);
}

/**
 * PHASE 2 — SMS equivalent of startDelivery above, calling the DEDICATED
 * start_partner_request_delivery_sms RPC (0042_sms_reply_correlation.sql)
 * rather than adding a parameter to start_partner_request_delivery itself:
 * Postgres's CREATE OR REPLACE FUNCTION cannot alter an existing function's
 * argument-type signature in place (adding a parameter — even with a
 * default — creates a SEPARATE overload, never a true replace), so a
 * distinctly-named sibling function is the only way to extend this
 * behavior without touching start_partner_request_delivery's own body at
 * all — see that migration's own header comment.
 */
async function startDeliverySms(deliveryId: string, hotelId: string, smsReplyCodeHash: string, supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc("start_partner_request_delivery_sms", {
    p_delivery_id: deliveryId,
    p_hotel_id: hotelId,
    p_sms_reply_code_hash: smsReplyCodeHash,
  });
  if (error) throw new Error(error.message);
}

async function completeDelivery(
  deliveryId: string,
  hotelId: string,
  outcome: "sent" | "failed" | "unknown",
  providerMessageId: string | null,
  lastErrorCode: string | null,
  supabase: SupabaseClient
): Promise<void> {
  const { error } = await supabase.rpc("complete_partner_request_delivery", {
    p_delivery_id: deliveryId,
    p_hotel_id: hotelId,
    p_outcome: outcome,
    p_provider_message_id: providerMessageId,
    p_last_error_code: lastErrorCode,
  });
  if (error) throw new Error(error.message);
}

async function applyDeliveryCommand(
  requestId: string,
  hotelId: string,
  command: "partner_delivery_succeeded" | "partner_delivery_failed" | "partner_delivery_ambiguous",
  supabase: SupabaseClient
): Promise<void> {
  const { error } = await supabase.rpc("apply_partner_request_command", {
    p_partner_request_id: requestId,
    p_hotel_id: hotelId,
    p_command: command,
    p_message: null,
    p_metadata: null,
  });
  if (error) throw new Error(error.message);
}

export interface DeliverPartnerRequestDeps extends PrepareWhatsAppPartnerRequestDeps, SendPreparedPartnerRequestDeps {
  supabase?: SupabaseClient;
}

export const WHATSAPP_SENDING_STALE_AFTER_MS = 5 * 60 * 1000;

export interface PartnerRequestDeliverySnapshot {
  id: string;
  status: PartnerRequestDeliveryStatus;
  updatedAt: string;
}

export async function getLatestPartnerRequestDelivery(
  requestId: string,
  hotelId: string,
  purpose: PartnerRequestDeliveryPurpose,
  supabase: SupabaseClient = createAdminClient()
): Promise<PartnerRequestDeliverySnapshot | null> {
  const { data, error } = await supabase
    .from("partner_request_deliveries")
    .select("id, status, updated_at")
    .eq("partner_request_id", requestId)
    .eq("hotel_id", hotelId)
    .eq("purpose", purpose)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; status: PartnerRequestDeliveryStatus; updated_at: string }>();
  if (error) throw new Error(error.message);
  return data ? { id: data.id, status: data.status, updatedAt: data.updated_at } : null;
}

export interface ReconcileStaleSendingDeps {
  supabase?: SupabaseClient;
  nowMs?: number;
  staleAfterMs?: number;
  /** PHASE 2 (reconfirmation cycle) — which purpose's latest delivery to re-read when checking for a concurrent winner. Defaults to "initial_request" — EVERY existing call site keeps its exact prior behavior unchanged. Was previously hardcoded inline; now a parameter so this same function can correctly reconcile an "alternative_acceptance" delivery too (see deliverPartnerRequestAlternativeAcceptance below) — reusing this instead of a parallel reconciliation function, per this session's own "ne crée pas une nouvelle state machine" instruction. */
  purpose?: PartnerRequestDeliveryPurpose;
}

/** Persist a stale `sending` as ambiguous. Never calls the provider. */
export async function reconcileStaleSendingDelivery(
  delivery: PartnerRequestDeliverySnapshot,
  requestId: string,
  hotelId: string,
  deps: ReconcileStaleSendingDeps = {}
): Promise<PartnerRequestDeliveryStatus> {
  if (delivery.status !== "sending") return delivery.status;
  const nowMs = deps.nowMs ?? Date.now();
  const staleAfterMs = deps.staleAfterMs ?? WHATSAPP_SENDING_STALE_AFTER_MS;
  if (nowMs - Date.parse(delivery.updatedAt) < staleAfterMs) return "sending";

  const purpose = deps.purpose ?? "initial_request";
  const supabase = resolveSupabase(deps.supabase);
  try {
    await completeDelivery(delivery.id, hotelId, "unknown", null, "provider_unknown", supabase);
  } catch (error) {
    // A concurrent reconciler may have won the row lock and completed the
    // exact same transition. Re-read before deciding whether this is a real
    // failure; only the winner is allowed to emit the domain event below.
    const current = await getLatestPartnerRequestDelivery(requestId, hotelId, purpose, supabase);
    if (current?.id === delivery.id && current.status === "unknown") return "unknown";
    throw error;
  }

  await applyDeliveryCommand(requestId, hotelId, "partner_delivery_ambiguous", supabase);
  const persisted = await getLatestPartnerRequestDelivery(requestId, hotelId, purpose, supabase);
  return persisted?.id === delivery.id ? persisted.status : "unknown";
}

/**
 * THE full delivery lifecycle (task section 11):
 *   0. prepareWhatsAppPartnerRequest — eligibility + purpose + content. If
 *      NOT eligible, returns immediately: NO delivery row is ever created
 *      for an attempt that was never really attempted.
 *   A. create_partner_request_delivery -> 'queued'. A concurrent attempt
 *      for the same (hotel, request, purpose) fails here with 23505 —
 *      mapped to "delivery_already_in_progress", the provider is NEVER
 *      called in that case (task section 12 — DB-backed, not an in-memory
 *      mutex).
 *   B/C. Three fresh opaque reply tokens generated; ONLY their hashes are
 *      persisted via start_partner_request_delivery (queued -> sending) —
 *      BEFORE the network call below. Even a crash immediately after this
 *      point leaves a durable 'sending' row behind, never silently lost.
 *   D. sendPreparedPartnerRequestTemplate — the actual call to Meta.
 *   E. Outcome mapping — see WhatsAppSendResult's own error union
 *      (provider_error = CERTAIN failure, provider_unknown = AMBIGUOUS,
 *      metaProvider.ts's own doc comment on why):
 *        ok: true            -> complete('sent', providerMessageId)   -> partner_delivery_succeeded -> sent_to_partner
 *        error: provider_error   -> complete('failed', null, code)    -> partner_delivery_failed    -> status unchanged
 *        error: provider_unknown -> complete('unknown', null, code)   -> partner_delivery_ambiguous  -> status unchanged, NEVER sent_to_partner, NEVER treated as a certain failure, NO automatic retry
 */
export async function deliverPartnerRequest(requestId: string, hotelId: string, deps: DeliverPartnerRequestDeps = {}): Promise<WhatsAppSendResult> {
  const supabase = resolveSupabase(deps.supabase);

  const prepared = await prepareWhatsAppPartnerRequest(requestId, hotelId, { supabase });
  if (!prepared.ok) return prepared;

  const provider = deps.provider ?? getConfiguredWhatsAppProvider();
  if (!provider) return { ok: false, error: "provider_not_configured", attempted: false };

  let deliveryId: string;
  try {
    deliveryId = await createDelivery(hotelId, requestId, prepared.prepared.purpose, PROVIDER_NAME, supabase);
  } catch (err) {
    if (err instanceof DeliveryAlreadyInProgressError) return { ok: false, error: "delivery_already_in_progress" };
    throw err;
  }

  const tokens = generatePartnerReplyTokenSet();
  await startDelivery(
    deliveryId,
    hotelId,
    {
      accept: tokens.accept.tokenHash,
      reject: tokens.reject.tokenHash,
      alternative: tokens.alternative.tokenHash,
    },
    supabase
  );

  const result = await sendPreparedPartnerRequestTemplate(
    prepared.prepared,
    { accept: tokens.accept.token, reject: tokens.reject.token, alternative: tokens.alternative.token },
    { provider }
  );

  if (result.ok) {
    await completeDelivery(deliveryId, hotelId, "sent", result.providerMessageId, null, supabase);
    await applyDeliveryCommand(requestId, hotelId, "partner_delivery_succeeded", supabase);
  } else if (result.error === "provider_error") {
    await completeDelivery(deliveryId, hotelId, "failed", null, result.error, supabase);
    await applyDeliveryCommand(requestId, hotelId, "partner_delivery_failed", supabase);
  } else if (result.error === "provider_unknown") {
    await completeDelivery(deliveryId, hotelId, "unknown", null, result.error, supabase);
    await applyDeliveryCommand(requestId, hotelId, "partner_delivery_ambiguous", supabase);
  }
  // Any other error (provider_not_configured, template_not_configured,
  // etc.) cannot happen here: prepareWhatsAppPartnerRequest already
  // resolved cleanly, and sendPreparedPartnerRequestTemplate only ever
  // returns provider-call outcomes (ok / provider_error / provider_unknown)
  // — see WhatsAppProvider.sendTemplateMessage's own contract.

  return result;
}

export interface DeliverPartnerRequestSmsDeps extends PrepareSmsPartnerRequestDeps, SendPreparedPartnerRequestSmsDeps {
  supabase?: SupabaseClient;
}

/**
 * PHASE 2 — SMS equivalent of deliverPartnerRequest above, same lifecycle
 * (prepare -> create 'queued' -> generate+persist the reply code hash
 * BEFORE the network call -> send -> complete). NOT called from
 * processPartnerRequestTurn or any other production trigger — this
 * function exists, is fully tested, but is not yet the active transport
 * for a real partner request (audited and explicitly validated this
 * session: "aucune modification du comportement WhatsApp existant" — the
 * WhatsApp path above remains the one actually wired to the chatbot).
 *
 * Only ONE opaque code is generated (not three tokens): the inbound SMS
 * digit (1/2/3), not which column matched, selects the command — see
 * resolvePartnerReplySms below and inboundParsing.ts's own doc comment.
 */
export async function deliverPartnerRequestViaSms(
  requestId: string,
  hotelId: string,
  deps: DeliverPartnerRequestSmsDeps = {}
): Promise<SmsSendResult | { ok: false; error: "delivery_already_in_progress" } | { ok: false; error: SmsPartnerRequestPreSendError }> {
  const supabase = resolveSupabase(deps.supabase);

  const prepared = await prepareSmsPartnerRequest(requestId, hotelId, { supabase });
  if (!prepared.ok) return prepared;

  const provider = deps.provider ?? getConfiguredSmsProvider();
  if (!provider) return { ok: false, error: "provider_not_configured" };

  let deliveryId: string;
  try {
    deliveryId = await createDelivery(hotelId, requestId, prepared.prepared.purpose, PROVIDER_NAME_SMS, supabase);
  } catch (err) {
    if (err instanceof DeliveryAlreadyInProgressError) return { ok: false, error: "delivery_already_in_progress" };
    throw err;
  }

  const { code, codeHash } = generateSmsReplyCode();
  await startDeliverySms(deliveryId, hotelId, codeHash, supabase);

  const result = await sendPreparedPartnerRequestSms(prepared.prepared, code, { provider });

  if (result.ok) {
    await completeDelivery(deliveryId, hotelId, "sent", result.providerMessageId, null, supabase);
    await applyDeliveryCommand(requestId, hotelId, "partner_delivery_succeeded", supabase);
  } else if (result.error === "provider_error") {
    await completeDelivery(deliveryId, hotelId, "failed", null, result.error, supabase);
    await applyDeliveryCommand(requestId, hotelId, "partner_delivery_failed", supabase);
  } else if (result.error === "provider_unknown") {
    await completeDelivery(deliveryId, hotelId, "unknown", null, result.error, supabase);
    await applyDeliveryCommand(requestId, hotelId, "partner_delivery_ambiguous", supabase);
  }

  return result;
}

/**
 * PHASE 2 — RECONFIRMATION CYCLE (closes the gap reported after the
 * previous turn: guest_accept_alternative alone never re-notifies the
 * partner). Determines which transport reached this partner ORIGINALLY —
 * from the persisted "initial_request" delivery's own `provider` column,
 * NEVER from anything the client supplies — and re-triggers the SAME,
 * ALREADY-BUILT delivery lifecycle (deliverPartnerRequest for "meta",
 * deliverPartnerRequestViaSms for "twilio_sms") with ZERO change to either:
 * both already resolve purpose="alternative_acceptance" automatically via
 * purposeForStatus(request.status) once status is "alternative_proposed"
 * (see this session's own short audit before this implementation). No new
 * state, no new RPC — only the transport SELECTION is new.
 */
async function getPartnerRequestTransport(requestId: string, hotelId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("partner_request_deliveries")
    .select("provider")
    .eq("partner_request_id", requestId)
    .eq("hotel_id", hotelId)
    .eq("purpose", "initial_request")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ provider: string }>();
  if (error) throw new Error(error.message);
  return data?.provider ?? null;
}

export interface DeliverPartnerRequestAlternativeAcceptanceDeps {
  supabase?: SupabaseClient;
  whatsappProvider?: DeliverPartnerRequestDeps["provider"];
  smsProvider?: DeliverPartnerRequestSmsDeps["provider"];
}

export type DeliverPartnerRequestAlternativeAcceptanceResult =
  | WhatsAppSendResult
  | SmsSendResult
  | { ok: false; error: "delivery_already_in_progress" }
  | { ok: false; error: SmsPartnerRequestPreSendError }
  | { ok: false; error: "transport_undetermined" };

/**
 * Called ONLY after guest_accept_alternative has already succeeded (see
 * features/rag/partnerRequestFlow.ts's own handleAlternativeProposedTurn).
 * "transport_undetermined" is a defensive fallback for a state that should
 * never occur in practice (a request cannot reach alternative_proposed
 * without a prior successful initial_request delivery) — never guessed at,
 * never defaults to either transport.
 */
export async function deliverPartnerRequestAlternativeAcceptance(
  requestId: string,
  hotelId: string,
  deps: DeliverPartnerRequestAlternativeAcceptanceDeps = {}
): Promise<DeliverPartnerRequestAlternativeAcceptanceResult> {
  const supabase = resolveSupabase(deps.supabase);
  const transport = await getPartnerRequestTransport(requestId, hotelId, supabase);

  if (transport === PROVIDER_NAME_SMS) {
    return deliverPartnerRequestViaSms(requestId, hotelId, { supabase, provider: deps.smsProvider });
  }
  if (transport === PROVIDER_NAME) {
    return deliverPartnerRequest(requestId, hotelId, { supabase, provider: deps.whatsappProvider });
  }
  return { ok: false, error: "transport_undetermined" };
}

export interface ResolvedPartnerReply {
  deliveryId: string;
  hotelId: string;
  partnerRequestId: string;
  command: PartnerReplyCommand;
}

const REPLY_TOKEN_COLUMNS: { column: "accept_reply_token_hash" | "reject_reply_token_hash" | "propose_alternative_token_hash"; command: PartnerReplyCommand }[] = [
  { column: "accept_reply_token_hash", command: "partner_accept" },
  { column: "reject_reply_token_hash", command: "partner_reject" },
  { column: "propose_alternative_token_hash", command: "partner_propose_alternative" },
];

/**
 * Resolves an inbound WhatsApp button tap's OPAQUE token to the exact
 * partner_request + command it authorizes — via a server-side SHA-256 hash
 * lookup against partner_request_deliveries, NEVER by decoding the token
 * itself (there is nothing to decode — see replyToken.ts's own doc
 * comment). This is the ONLY correlation mechanism; a token that doesn't
 * match any row here is indistinguishable from "not a reply token at all".
 *
 * TOKEN VALIDITY (task section 9): only resolves against a delivery whose
 * status is 'sent' or 'unknown' — a message that was CONFIRMED sent, or
 * one whose fate is unknown (Meta's acceptance could not be excluded, so
 * the partner may genuinely have received the buttons). A delivery at
 * 'failed' never authorizes its old reply tokens (the message is known to
 * never have reached the partner); 'queued'/'sending' never had a chance
 * to reach the partner either. Tries each of the three hash columns in
 * turn — same "simpler to reason about than a combined OR filter"
 * discipline as features/partners/consentLookup.ts's own doc comment.
 */
export async function resolvePartnerReplyToken(rawToken: string, supabase: SupabaseClient = createAdminClient()): Promise<ResolvedPartnerReply | null> {
  if (!rawToken) return null;
  const tokenHash = hashPartnerReplyToken(rawToken);

  for (const { column, command } of REPLY_TOKEN_COLUMNS) {
    const { data, error } = await supabase
      .from("partner_request_deliveries")
      .select("id, hotel_id, partner_request_id")
      .eq(column, tokenHash)
      .in("status", ["sent", "unknown"])
      .maybeSingle<{ id: string; hotel_id: string; partner_request_id: string }>();
    if (error) {
      console.error("resolvePartnerReplyToken: lookup failed", { message: error.message });
      return null;
    }
    if (data) {
      return { deliveryId: data.id, hotelId: data.hotel_id, partnerRequestId: data.partner_request_id, command };
    }
  }

  return null;
}

/**
 * Applies a partner's WhatsApp button reply — callable ONLY with a
 * `command`/`partnerRequestId`/`hotelId` triple that has already been
 * resolved via resolvePartnerReplyToken() above (itself only ever
 * consulted from the webhook boundary). This function performs no
 * verification of its own, by design: verification+correlation happens
 * exactly once, at resolvePartnerReplyToken(), and its result is what this
 * function trusts. The FINAL authorization check — is this command still
 * legal from the partner_request's CURRENT status — happens inside
 * apply_partner_request_command() itself (0020_partner_requests.sql's own
 * row lock + status guard): a stale/replayed reply can never force a
 * transition the state machine doesn't already allow.
 *
 * `message` is the partner's own free-text reply if any (relevant for
 * partner_propose_alternative) — MUST already be sanitized by the caller,
 * per partner_request_events.message's own schema-level discipline
 * (0020_partner_requests.sql's column comment).
 */
export async function applyPartnerReplyCommand(
  partnerRequestId: string,
  hotelId: string,
  command: PartnerReplyCommand,
  message: string | null,
  supabase: SupabaseClient = createAdminClient()
): Promise<void> {
  const { error } = await supabase.rpc("apply_partner_request_command", {
    p_partner_request_id: partnerRequestId,
    p_hotel_id: hotelId,
    p_command: command,
    p_message: message,
    p_metadata: null,
  });
  if (error) throw new Error(error.message);
}

const SMS_DIGIT_TO_PARTNER_COMMAND: Record<"1" | "2" | "3", PartnerReplyCommand> = {
  "1": "partner_accept",
  "2": "partner_reject",
  "3": "partner_propose_alternative",
};

export interface ResolvedPartnerSmsReply {
  deliveryId: string;
  hotelId: string;
  partnerRequestId: string;
  command: PartnerReplyCommand;
  /** Sanitized free text for partner_propose_alternative — see redactPhoneNumbers below. Always null for accept/reject. */
  message: string | null;
}

export type ResolvePartnerReplySmsOutcome =
  | { ok: true; resolved: ResolvedPartnerSmsReply }
  | { ok: false; reason: "unparseable" | "code_not_found" | "wrong_sender" | "missing_alternative_text" };

/** hotel_partners.request_phone_e164 is the ONLY source of truth for "who is this delivery's expected sender" — never anything derived from the inbound SMS itself. */
async function getPartnerPhoneForRequest(hotelId: string, partnerRequestId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data: request, error: requestError } = await supabase
    .from("partner_requests")
    .select("partner_id")
    .eq("id", partnerRequestId)
    .eq("hotel_id", hotelId)
    .maybeSingle<{ partner_id: string }>();
  if (requestError) throw new Error(requestError.message);
  if (!request) return null;

  const { data: partner, error: partnerError } = await supabase
    .from("hotel_partners")
    .select("request_phone_e164")
    .eq("id", request.partner_id)
    .eq("hotel_id", hotelId)
    .maybeSingle<{ request_phone_e164: string | null }>();
  if (partnerError) throw new Error(partnerError.message);
  return partner?.request_phone_e164 ?? null;
}

/** Both sides are already E.164 (Twilio's own From, hotel_partners.request_phone_e164's own DB CHECK) — exact string comparison after trimming is the correct, sufficient normalization; no further reformatting is safe to guess at. */
function phoneNumbersMatch(expected: string, actual: string): boolean {
  return expected.trim() === actual.trim();
}

/**
 * Resolves an inbound SMS reply (`<digit> <code> [free text]`, see
 * inboundParsing.ts) to the exact partner_request + command it authorizes —
 * mirrors resolvePartnerReplyToken's own "hash lookup, never decode"
 * discipline, adapted for the single-code-per-delivery SMS model (task
 * section D/E, audited and validated this session):
 *
 *   1. Parse the body deterministically — never the model.
 *   2. digit "3" with no free text is refused HERE, before any DB lookup —
 *      the request is never touched (task's own explicit requirement).
 *   3. Hash the code, look up ONLY twilio_sms deliveries in 'sent'/'unknown'
 *      status — same validity window as WhatsApp's own token resolution.
 *   4. From-number cross-check against hotel_partners.request_phone_e164 —
 *      the mandatory defense-in-depth this session validated for the
 *      shorter, human-typable code (never present for WhatsApp's 256-bit
 *      token, which needs no such check).
 *   5. hotel_id/partner_request_id are read EXCLUSIVELY from the resolved
 *      delivery row — never derived from the SMS body or From number.
 *
 * The free-text alternative (digit 3) is sanitized via the SAME
 * redactPhoneNumbers() rule already documented on
 * partner_request_events.message (0020_partner_requests.sql) — never a new
 * sanitization rule invented here.
 */
export async function resolvePartnerReplySms(rawBody: string, fromE164: string, supabase: SupabaseClient = createAdminClient()): Promise<ResolvePartnerReplySmsOutcome> {
  const parsed = parseInboundSmsBody(rawBody);
  if (!parsed) return { ok: false, reason: "unparseable" };
  if (parsed.digit === "3" && !parsed.freeText) return { ok: false, reason: "missing_alternative_text" };

  const codeHash = hashSmsReplyCode(parsed.code);
  const { data, error } = await supabase
    .from("partner_request_deliveries")
    .select("id, hotel_id, partner_request_id")
    .eq("sms_reply_code_hash", codeHash)
    .eq("provider", PROVIDER_NAME_SMS)
    .in("status", ["sent", "unknown"])
    .maybeSingle<{ id: string; hotel_id: string; partner_request_id: string }>();
  if (error) {
    console.error("resolvePartnerReplySms: lookup failed", { message: error.message });
    return { ok: false, reason: "code_not_found" };
  }
  if (!data) return { ok: false, reason: "code_not_found" };

  const expectedPhone = await getPartnerPhoneForRequest(data.hotel_id, data.partner_request_id, supabase);
  if (!expectedPhone || !phoneNumbersMatch(expectedPhone, fromE164)) {
    return { ok: false, reason: "wrong_sender" };
  }

  const command = SMS_DIGIT_TO_PARTNER_COMMAND[parsed.digit];
  const message = parsed.digit === "3" ? redactPhoneNumbers(parsed.freeText as string).sanitizedText : null;

  return { ok: true, resolved: { deliveryId: data.id, hotelId: data.hotel_id, partnerRequestId: data.partner_request_id, command, message } };
}
