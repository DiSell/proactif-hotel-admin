import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPartnerRequestById } from "@/features/partnerRequests/queries";
import { formatPartnerRequestDate, formatPartnerRequestTime } from "@/features/partnerRequests/presentation";
import type { PartnerRequestDeliveryPurpose, PartnerRequestStatus } from "@/features/partnerRequests/types";
import { canReceivePartnerRequests } from "@/features/partners/canReceivePartnerRequests";
import type { HotelPartnerConsentStatus } from "@/types/database";
import { getSmsProvider } from "./provider";
import type { SmsProvider, SmsSendResult } from "./types";

/**
 * SMS content builder for partner requests — mirrors
 * whatsapp/sendPartnerRequest.ts's own "prepare (no network, pure
 * eligibility) / send (the one place a message leaves this server)" split.
 * Small eligibility helpers (getPartnerForNotification-equivalent,
 * getHotelName, firstNameOnly, purposeForStatus) are DUPLICATED here rather
 * than imported from the WhatsApp module — same "the two transports must
 * stay independent, no real cost to a few duplicated lines" precedent
 * already established by spaBookingReplyToken.ts vs replyToken.ts. This
 * file makes ZERO changes to lib/notifications/whatsapp/*.
 *
 * KNOWN LIMITATION, carried over unchanged from this session's own audit:
 * eligibility reuses hotel_partners.whatsapp_consent_status — the only
 * transactional consent gate that exists today. That column is
 * WhatsApp-scoped by name and origin (0022_partner_transactional_consent.sql);
 * a dedicated SMS consent flag was flagged as a real product/legal question
 * during the audit, deliberately NOT decided or built here (not requested
 * this phase) — this reuse is a pragmatic stand-in, not a new decision.
 */

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export type SmsPartnerRequestPreSendError = "request_not_found" | "request_not_eligible" | "partner_not_eligible" | "missing_phone" | "invalid_phone";

interface PrivatePartnerForSmsNotification {
  id: string;
  hotel_id: string;
  name: string;
  category: string;
  is_active: boolean;
  consent_status: HotelPartnerConsentStatus;
  whatsapp_consent_status: HotelPartnerConsentStatus;
  request_phone_e164: string | null;
}

async function getPartnerForSmsNotification(hotelId: string, partnerId: string, supabase: SupabaseClient): Promise<PrivatePartnerForSmsNotification | null> {
  const { data, error } = await supabase
    .from("hotel_partners")
    .select("id, hotel_id, name, category, is_active, consent_status, whatsapp_consent_status, request_phone_e164")
    .eq("id", partnerId)
    .eq("hotel_id", hotelId)
    .maybeSingle<PrivatePartnerForSmsNotification>();
  if (error) throw new Error(error.message);
  return data;
}

async function getHotelName(hotelId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("hotels").select("name").eq("id", hotelId).maybeSingle<{ name: string }>();
  if (error) throw new Error(error.message);
  return data?.name ?? null;
}

function firstNameOnly(guestName: string | null): string | null {
  const trimmed = guestName?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

/** Same rule as whatsapp/sendPartnerRequest.ts's own (private) purposeForStatus — duplicated, not shared, per this file's own header comment. */
function purposeForStatus(status: PartnerRequestStatus): PartnerRequestDeliveryPurpose | null {
  if (status === "pending_confirmation") return "initial_request";
  if (status === "alternative_proposed") return "alternative_acceptance";
  return null;
}

export interface PreparedPartnerRequestSms {
  purpose: PartnerRequestDeliveryPurpose;
  requestPhoneE164: string;
  hotelName: string;
  requestCategory: string;
  requestedDate: string | null;
  requestedTime: string | null;
  partySize: number | null;
  guestFirstName: string | null;
  /** The partner's own alternative proposal (partner_requests.partner_response) — only meaningful when purpose === "alternative_acceptance", null otherwise. Never derived/guessed: read verbatim from the DB. */
  partnerResponse: string | null;
}

export type PrepareSmsPartnerRequestResult = { ok: true; prepared: PreparedPartnerRequestSms } | { ok: false; error: SmsPartnerRequestPreSendError };

export interface PrepareSmsPartnerRequestDeps {
  supabase?: SupabaseClient;
}

/** All eligibility checks + the business facts the SMS will contain — NO network call, no code generated here (see deliveryService.ts, which generates the code and persists its hash BEFORE the send). */
export async function prepareSmsPartnerRequest(requestId: string, hotelId: string, deps: PrepareSmsPartnerRequestDeps = {}): Promise<PrepareSmsPartnerRequestResult> {
  const supabase = deps.supabase ?? createAdminClient();

  const request = await getPartnerRequestById(hotelId, requestId, supabase);
  if (!request) return { ok: false, error: "request_not_found" };

  const purpose = purposeForStatus(request.status);
  if (!purpose) return { ok: false, error: "request_not_eligible" };

  const partner = await getPartnerForSmsNotification(hotelId, request.partner_id, supabase);
  if (!partner) return { ok: false, error: "partner_not_eligible" };

  if (!partner.request_phone_e164) return { ok: false, error: "missing_phone" };
  if (!E164_PATTERN.test(partner.request_phone_e164)) return { ok: false, error: "invalid_phone" };

  if (!canReceivePartnerRequests(partner)) return { ok: false, error: "partner_not_eligible" };

  const hotelName = await getHotelName(hotelId, supabase);
  if (!hotelName) return { ok: false, error: "request_not_eligible" };

  return {
    ok: true,
    prepared: {
      purpose,
      requestPhoneE164: partner.request_phone_e164,
      hotelName,
      requestCategory: partner.category,
      requestedDate: request.requested_date,
      requestedTime: request.requested_time,
      partySize: request.party_size,
      guestFirstName: firstNameOnly(request.guest_name),
      partnerResponse: request.partner_response,
    },
  };
}

/**
 * Pure text construction — the exact wording is a product decision left
 * intentionally simple/legible for a restaurateur reading it on a phone,
 * not finalized wordsmithing. Digit 3's own line ALWAYS shows the code
 * followed by a placeholder for free text, never a bare "3 CODE" — a reply
 * with no text after the code is rejected cleanly downstream (see
 * inboundParsing.ts's own freeText: null case), never silently accepted as
 * a no-op alternative.
 */
export function buildPartnerRequestSmsBody(prepared: PreparedPartnerRequestSms, code: string): string {
  const lines = [`${prepared.hotelName} — Nouvelle demande`, prepared.requestCategory];
  if (prepared.partySize) lines.push(`${prepared.partySize} personnes`);
  if (prepared.requestedDate) lines.push(`Date : ${formatPartnerRequestDate(prepared.requestedDate)}`);
  if (prepared.requestedTime) lines.push(`Horaire demandé : ${formatPartnerRequestTime(prepared.requestedTime)}`);
  if (prepared.guestFirstName) lines.push(`Client : ${prepared.guestFirstName}`);
  lines.push("", "Répondez :", `1 ${code} = accepter`, `2 ${code} = refuser`, `3 ${code} [votre proposition] = proposer une alternative`);
  return lines.join("\n");
}

/**
 * PHASE 2 (reconfirmation cycle) — strictly 2 reply lines, NEVER a digit 3:
 * the client has already accepted the partner's own proposal, there is
 * nothing left to counter-propose at this step. `prepared.partnerResponse`
 * is shown verbatim (never re-derived) — the exact text the partner sent
 * earlier, read straight from partner_requests.partner_response.
 */
export function buildPartnerRequestReconfirmationSmsBody(prepared: PreparedPartnerRequestSms, code: string): string {
  const lines = [
    `${prepared.hotelName} — Confirmation demandée`,
    "",
    "Le client accepte votre proposition :",
    prepared.partnerResponse ?? "—",
    "",
    "Merci de confirmer définitivement :",
    `1 ${code} = confirmer`,
    `2 ${code} = refuser`,
  ];
  return lines.join("\n");
}

export interface SendPreparedPartnerRequestSmsDeps {
  provider?: SmsProvider;
}

/**
 * The ONLY place a partner-request SMS actually leaves this server. `code`
 * is the RAW opaque code — generated by, and whose hash is already durably
 * persisted by, the caller (deliveryService.ts) BEFORE this function is
 * ever invoked — always a FRESH code per call, never reused across
 * deliveries. The message content branches on `prepared.purpose`: the
 * initial 3-option request, or the 2-option reconfirmation once the client
 * has accepted the partner's own counter-proposal.
 */
export async function sendPreparedPartnerRequestSms(
  prepared: PreparedPartnerRequestSms,
  code: string,
  deps: SendPreparedPartnerRequestSmsDeps = {}
): Promise<SmsSendResult> {
  const provider = deps.provider ?? getSmsProvider();
  const body = prepared.purpose === "alternative_acceptance" ? buildPartnerRequestReconfirmationSmsBody(prepared, code) : buildPartnerRequestSmsBody(prepared, code);
  return provider.sendSms({ toE164: prepared.requestPhoneE164, body });
}
