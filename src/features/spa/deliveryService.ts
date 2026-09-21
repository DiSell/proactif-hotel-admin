import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  prepareWhatsAppSpaBookingApproval,
  sendPreparedSpaBookingApprovalTemplate,
  type PrepareSpaBookingApprovalDeps,
  type SendPreparedSpaBookingApprovalDeps,
} from "@/lib/notifications/whatsapp/sendSpaBookingApproval";
import { generateSpaBookingReplyTokenSet, hashSpaBookingReplyToken } from "@/lib/notifications/whatsapp/spaBookingReplyToken";
import type { WhatsAppSendResult } from "@/lib/notifications/whatsapp/types";
import { getConfiguredWhatsAppProvider } from "@/lib/notifications/whatsapp/provider";
import {
  prepareSmsSpaBookingApproval,
  sendPreparedSpaBookingApprovalSms,
  type PrepareSmsSpaBookingApprovalDeps,
  type SendPreparedSpaBookingApprovalSmsDeps,
  type SmsSpaBookingApprovalPreSendError,
} from "@/lib/notifications/sms/sendSpaBookingApprovalSms";
import { generateSmsReplyCode, hashSmsReplyCode } from "@/lib/notifications/sms/smsReplyCode";
import { parseInboundSmsBody } from "@/lib/notifications/sms/inboundParsing";
import { getConfiguredSmsProvider } from "@/lib/notifications/sms/provider";
import type { SmsSendResult } from "@/lib/notifications/sms/types";

/**
 * Mirrors features/partnerRequests/deliveryService.ts almost exactly (same
 * delivery lifecycle: queued -> sending -> sent/failed/unknown, same
 * idempotency/concurrency guard via spa_booking_deliveries_active_booking_key),
 * minus the "purpose" dimension — a spa-booking approval request is only
 * ever sent once, to the hotel's own admin number, never to the guest.
 *
 * Deliberately a SEPARATE module from features/partnerRequests/deliveryService.ts
 * (own domain, own table, own reply-token space) rather than a generalized
 * shared one — same reasoning as features/rag/confirmation.ts's own
 * extraction: the two domains must never be able to cross-resolve a token.
 */

const PROVIDER_NAME = "meta";
/** PHASE 2 — Twilio SMS transport, see deliverSpaBookingApprovalRequestViaSms/resolveSpaBookingReplySms below. */
const PROVIDER_NAME_SMS = "twilio_sms";

function resolveSupabase(supabase: SupabaseClient | undefined): SupabaseClient {
  return supabase ?? createAdminClient();
}

class DeliveryAlreadyInProgressError extends Error {}

/** `provider` is explicit (not a module const) so this one function serves both transports — see partnerRequests/deliveryService.ts's own identical reasoning. WhatsApp's call site below passes PROVIDER_NAME exactly as before. */
async function createDelivery(hotelId: string, bookingId: string, provider: string, supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase.rpc("create_spa_booking_delivery", {
    p_hotel_id: hotelId,
    p_booking_id: bookingId,
    p_provider: provider,
  });
  if (error) {
    if (error.code === "23505") throw new DeliveryAlreadyInProgressError();
    throw new Error(error.message);
  }
  return data as string;
}

async function startDelivery(deliveryId: string, hotelId: string, tokenHashes: { accept: string; reject: string }, supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc("start_spa_booking_delivery", {
    p_delivery_id: deliveryId,
    p_hotel_id: hotelId,
    p_accept_token_hash: tokenHashes.accept,
    p_reject_token_hash: tokenHashes.reject,
  });
  if (error) throw new Error(error.message);
}

/** PHASE 2 — SMS equivalent, calling the dedicated start_spa_booking_delivery_sms RPC (0042_sms_reply_correlation.sql) — same "distinct sibling function, never a same-name overload" reasoning as partnerRequests/deliveryService.ts's own startDeliverySms. */
async function startDeliverySms(deliveryId: string, hotelId: string, smsReplyCodeHash: string, supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc("start_spa_booking_delivery_sms", {
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
  const { error } = await supabase.rpc("complete_spa_booking_delivery", {
    p_delivery_id: deliveryId,
    p_hotel_id: hotelId,
    p_outcome: outcome,
    p_provider_message_id: providerMessageId,
    p_last_error_code: lastErrorCode,
  });
  if (error) throw new Error(error.message);
}

export type SpaBookingReplyCommand = "approve" | "reject";

async function applyDecision(bookingId: string, hotelId: string, command: SpaBookingReplyCommand, supabase: SupabaseClient): Promise<void> {
  if (command === "approve") {
    const { error } = await supabase.rpc("approve_spa_booking", { p_hotel_id: hotelId, p_booking_id: bookingId });
    if (error) throw new Error(error.message);
    return;
  }
  const { error } = await supabase.rpc("cancel_spa_booking", { p_hotel_id: hotelId, p_booking_id: bookingId, p_cancelled_by: "hotel" });
  if (error) throw new Error(error.message);
}

export interface DeliverSpaBookingApprovalDeps extends PrepareSpaBookingApprovalDeps, SendPreparedSpaBookingApprovalDeps {
  supabase?: SupabaseClient;
}

/**
 * THE full delivery lifecycle, mirroring deliverPartnerRequest exactly:
 *   0. prepareWhatsAppSpaBookingApproval — eligibility + content. Not
 *      eligible -> return immediately, no delivery row created.
 *   A. create_spa_booking_delivery -> 'queued'. A concurrent attempt for
 *      the same booking fails here with 23505, mapped to
 *      "delivery_already_in_progress" — the provider is never called.
 *   B/C. Two fresh opaque reply tokens; only their hashes are persisted via
 *      start_spa_booking_delivery (queued -> sending) BEFORE the network
 *      call.
 *   D. sendPreparedSpaBookingApprovalTemplate — the actual call to Meta.
 *   E. Outcome mapping — same as partner: ok -> sent, provider_error ->
 *      failed, provider_unknown -> unknown (never a silent retry).
 */
export async function deliverSpaBookingApprovalRequest(
  bookingId: string,
  hotelId: string,
  deps: DeliverSpaBookingApprovalDeps = {}
): Promise<WhatsAppSendResult | { ok: false; error: string }> {
  const supabase = resolveSupabase(deps.supabase);

  const prepared = await prepareWhatsAppSpaBookingApproval(bookingId, hotelId, { supabase });
  if (!prepared.ok) return prepared;

  const provider = deps.provider ?? getConfiguredWhatsAppProvider();
  if (!provider) return { ok: false, error: "provider_not_configured" };

  let deliveryId: string;
  try {
    deliveryId = await createDelivery(hotelId, bookingId, PROVIDER_NAME, supabase);
  } catch (err) {
    if (err instanceof DeliveryAlreadyInProgressError) return { ok: false, error: "delivery_already_in_progress" };
    throw err;
  }

  const tokens = generateSpaBookingReplyTokenSet();
  await startDelivery(deliveryId, hotelId, { accept: tokens.accept.tokenHash, reject: tokens.reject.tokenHash }, supabase);

  const result = await sendPreparedSpaBookingApprovalTemplate(prepared.prepared, { accept: tokens.accept.token, reject: tokens.reject.token }, { provider });

  if (result.ok) {
    await completeDelivery(deliveryId, hotelId, "sent", result.providerMessageId, null, supabase);
  } else if (result.error === "provider_error") {
    await completeDelivery(deliveryId, hotelId, "failed", null, result.error, supabase);
  } else if (result.error === "provider_unknown") {
    await completeDelivery(deliveryId, hotelId, "unknown", null, result.error, supabase);
  }

  return result;
}

export interface DeliverSpaBookingApprovalSmsDeps extends PrepareSmsSpaBookingApprovalDeps, SendPreparedSpaBookingApprovalSmsDeps {
  supabase?: SupabaseClient;
}

/**
 * PHASE 2 — SMS equivalent of deliverSpaBookingApprovalRequest above. NOT
 * called from createSpaBookingForChatbot or any other production trigger —
 * built and tested, not yet the active transport (audited and validated
 * this session: WhatsApp remains unchanged as the active path). Strictly 2
 * options (approve/reject) — no alternative concept for spa, no digit 3.
 */
export async function deliverSpaBookingApprovalRequestViaSms(
  bookingId: string,
  hotelId: string,
  deps: DeliverSpaBookingApprovalSmsDeps = {}
): Promise<SmsSendResult | { ok: false; error: "delivery_already_in_progress" } | { ok: false; error: SmsSpaBookingApprovalPreSendError }> {
  const supabase = resolveSupabase(deps.supabase);

  const prepared = await prepareSmsSpaBookingApproval(bookingId, hotelId, { supabase });
  if (!prepared.ok) return prepared;

  const provider = deps.provider ?? getConfiguredSmsProvider();
  if (!provider) return { ok: false, error: "provider_not_configured" };

  let deliveryId: string;
  try {
    deliveryId = await createDelivery(hotelId, bookingId, PROVIDER_NAME_SMS, supabase);
  } catch (err) {
    if (err instanceof DeliveryAlreadyInProgressError) return { ok: false, error: "delivery_already_in_progress" };
    throw err;
  }

  const { code, codeHash } = generateSmsReplyCode();
  await startDeliverySms(deliveryId, hotelId, codeHash, supabase);

  const result = await sendPreparedSpaBookingApprovalSms(prepared.prepared, code, { provider });

  if (result.ok) {
    await completeDelivery(deliveryId, hotelId, "sent", result.providerMessageId, null, supabase);
  } else if (result.error === "provider_error") {
    await completeDelivery(deliveryId, hotelId, "failed", null, result.error, supabase);
  } else if (result.error === "provider_unknown") {
    await completeDelivery(deliveryId, hotelId, "unknown", null, result.error, supabase);
  }

  return result;
}

export interface ResolvedSpaBookingReply {
  deliveryId: string;
  hotelId: string;
  bookingId: string;
  command: SpaBookingReplyCommand;
}

const REPLY_TOKEN_COLUMNS: { column: "accept_reply_token_hash" | "reject_reply_token_hash"; command: SpaBookingReplyCommand }[] = [
  { column: "accept_reply_token_hash", command: "approve" },
  { column: "reject_reply_token_hash", command: "reject" },
];

/**
 * Resolves an inbound WhatsApp button tap's OPAQUE token to the exact spa
 * booking + command it authorizes — mirrors resolvePartnerReplyToken
 * exactly (same "sent or unknown status only" validity rule, same
 * try-each-column approach).
 */
export async function resolveSpaBookingReplyToken(rawToken: string, supabase: SupabaseClient = createAdminClient()): Promise<ResolvedSpaBookingReply | null> {
  if (!rawToken) return null;
  const tokenHash = hashSpaBookingReplyToken(rawToken);

  for (const { column, command } of REPLY_TOKEN_COLUMNS) {
    const { data, error } = await supabase
      .from("spa_booking_deliveries")
      .select("id, hotel_id, booking_id")
      .eq(column, tokenHash)
      .in("status", ["sent", "unknown"])
      .maybeSingle<{ id: string; hotel_id: string; booking_id: string }>();
    if (error) {
      console.error("resolveSpaBookingReplyToken: lookup failed", { message: error.message });
      return null;
    }
    if (data) {
      return { deliveryId: data.id, hotelId: data.hotel_id, bookingId: data.booking_id, command };
    }
  }

  return null;
}

/**
 * Applies the hotel's WhatsApp button reply — callable ONLY with a
 * command/bookingId/hotelId triple already resolved via
 * resolveSpaBookingReplyToken above. approve_spa_booking()/cancel_spa_booking()
 * themselves are the FINAL authorization check (row lock + status guard) —
 * a stale/replayed reply can never force a transition the booking's own
 * current status doesn't already allow.
 */
export async function applySpaBookingReplyCommand(
  bookingId: string,
  hotelId: string,
  command: SpaBookingReplyCommand,
  supabase: SupabaseClient = createAdminClient()
): Promise<void> {
  await applyDecision(bookingId, hotelId, command, supabase);
}

const SMS_DIGIT_TO_SPA_COMMAND: Partial<Record<"1" | "2" | "3", SpaBookingReplyCommand>> = {
  "1": "approve",
  "2": "reject",
  // Deliberately no "3" entry — a spa booking has no alternative concept
  // (audited and explicitly validated this session: "aucune alternative
  // ajoutée au SPA"). A "3 CODE ..." reply resolves to "invalid_digit"
  // below, exactly like any other malformed reply — never a silent no-op
  // acceptance of a concept that does not exist for this domain.
};

export interface ResolvedSpaBookingSmsReply {
  deliveryId: string;
  hotelId: string;
  bookingId: string;
  command: SpaBookingReplyCommand;
}

export type ResolveSpaBookingReplySmsOutcome =
  | { ok: true; resolved: ResolvedSpaBookingSmsReply }
  | { ok: false; reason: "unparseable" | "invalid_digit" | "code_not_found" | "wrong_sender" };

/** hotel_spa_settings.whatsapp_admin_phone_e164 — reused as-is per this session's own audit conclusion (see sendSpaBookingApprovalSms.ts's own doc comment on this field). */
async function getSpaAdminPhoneForBooking(hotelId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("hotel_spa_settings")
    .select("whatsapp_admin_phone_e164")
    .eq("hotel_id", hotelId)
    .maybeSingle<{ whatsapp_admin_phone_e164: string | null }>();
  if (error) throw new Error(error.message);
  return data?.whatsapp_admin_phone_e164 ?? null;
}

function phoneNumbersMatch(expected: string, actual: string): boolean {
  return expected.trim() === actual.trim();
}

/**
 * Resolves an inbound SMS reply to the exact spa booking + command it
 * authorizes — mirrors resolvePartnerReplySms (features/partnerRequests/
 * deliveryService.ts) exactly, minus the free-text/digit-3 case, which does
 * not exist for spa. hotel_id/booking_id come EXCLUSIVELY from the resolved
 * delivery row, never from the SMS body or From number.
 */
export async function resolveSpaBookingReplySms(rawBody: string, fromE164: string, supabase: SupabaseClient = createAdminClient()): Promise<ResolveSpaBookingReplySmsOutcome> {
  const parsed = parseInboundSmsBody(rawBody);
  if (!parsed) return { ok: false, reason: "unparseable" };

  const command = SMS_DIGIT_TO_SPA_COMMAND[parsed.digit];
  if (!command) return { ok: false, reason: "invalid_digit" };

  const codeHash = hashSmsReplyCode(parsed.code);
  const { data, error } = await supabase
    .from("spa_booking_deliveries")
    .select("id, hotel_id, booking_id")
    .eq("sms_reply_code_hash", codeHash)
    .eq("provider", PROVIDER_NAME_SMS)
    .in("status", ["sent", "unknown"])
    .maybeSingle<{ id: string; hotel_id: string; booking_id: string }>();
  if (error) {
    console.error("resolveSpaBookingReplySms: lookup failed", { message: error.message });
    return { ok: false, reason: "code_not_found" };
  }
  if (!data) return { ok: false, reason: "code_not_found" };

  const expectedPhone = await getSpaAdminPhoneForBooking(data.hotel_id, supabase);
  if (!expectedPhone || !phoneNumbersMatch(expectedPhone, fromE164)) {
    return { ok: false, reason: "wrong_sender" };
  }

  return { ok: true, resolved: { deliveryId: data.id, hotelId: data.hotel_id, bookingId: data.booking_id, command } };
}
