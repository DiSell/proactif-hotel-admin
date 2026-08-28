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
import type { PartnerReplyCommand } from "./types";

/**
 * Adapted to use partner_request_deliveries (0023_partner_request_deliveries.sql)
 * for BOTH durable delivery-attempt tracking and opaque reply-token
 * correlation — replacing the earlier design where reply tokens
 * self-encoded (HMAC-signed but NOT encrypted, therefore not confidential)
 * partnerRequestId/hotelId/command directly.
 *
 * ISOLATED orchestrator — NOT called from any production path in this
 * task. Neither the chatbot (features/rag/partnerRequestFlow.ts) nor any
 * Server Action calls deliverPartnerRequest() or applyPartnerReplyCommand()
 * as of this change — see the final report's own confirmation. This file
 * exists so the succeeded/failed/ambiguous sequencing can be built and
 * tested NOW, ready to be wired to a real trigger once product decides
 * WHEN a confirmed request should actually be dispatched.
 *
 * Deliberately separate from features/partnerRequests/chatbotService.ts:
 * that file is structurally incapable of calling
 * partner_delivery_succeeded/partner_delivery_failed/partner_delivery_ambiguous
 * (see its own ChatbotPartnerRequestCommand type) — this is the ONLY place
 * those three commands are ever issued, and it is reachable only from the
 * notification layer, never from a guest-facing chat turn.
 */

const PROVIDER_NAME = "meta"; // the only WhatsAppProvider implemented so far (metaProvider.ts) — would become dynamic if a second provider is ever added.

function resolveSupabase(supabase: SupabaseClient | undefined): SupabaseClient {
  return supabase ?? createAdminClient();
}

/** Thrown by createDelivery() ONLY for the one error the caller must handle specially — every other RPC failure propagates as a generic Error, matching every other RPC wrapper in this codebase (chatbotService.ts, actions.ts). */
class DeliveryAlreadyInProgressError extends Error {}

async function createDelivery(hotelId: string, partnerRequestId: string, purpose: string, supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("create_partner_request_delivery", {
    p_hotel_id: hotelId,
    p_partner_request_id: partnerRequestId,
    p_provider: PROVIDER_NAME,
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
    deliveryId = await createDelivery(hotelId, requestId, prepared.prepared.purpose, supabase);
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
