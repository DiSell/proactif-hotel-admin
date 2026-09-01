import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWhatsAppProvider } from "./provider";
import type { WhatsAppProvider, WhatsAppSendResult } from "./types";

/**
 * Mirrors sendPartnerRequest.ts almost exactly — same "prepare (no network,
 * pure eligibility) / send (the one place a message leaves this server)"
 * split, same discipline on never logging a phone number or a raw token.
 * Two differences from the partner-request version: (1) this notifies the
 * HOTEL's own admin number (hotel_spa_settings.whatsapp_admin_phone_e164),
 * never the guest, and (2) only 2 buttons (Confirmer/Refuser), never 3 — a
 * spa booking has no "propose an alternative" concept.
 *
 * Uses the SAME shared, system-wide WhatsApp Business Account as partner
 * notifications (WHATSAPP_META_* env vars) — deliberately NOT each hotel's
 * own connected number (hotel_whatsapp_connections), which this session's
 * own audit confirmed is not wired to any send/receive path today.
 */

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/; // duplicated deliberately, same precedent as sendPartnerRequest.ts's own copy
const SPA_BOOKING_APPROVAL_TEMPLATE_ENV = "WHATSAPP_SPA_BOOKING_APPROVAL_TEMPLATE";
const TEMPLATE_LANGUAGE_CODE = "fr";

/**
 * Deliberately its own closed vocabulary — NOT WhatsAppPreSendError
 * (types.ts), whose members ("partner_not_eligible", "request_not_found"...)
 * are worded for the partner-request domain and would be misleading here.
 */
export type SpaBookingApprovalPreSendError = "provider_not_configured" | "booking_not_eligible" | "missing_phone" | "invalid_phone" | "template_not_configured";

interface PrivateSpaBookingForNotification {
  id: string;
  hotel_id: string;
  status: string;
  guest_name: string | null;
  guest_phone_e164: string | null;
  party_size: number;
  booking_date: string;
  slot_start: string;
  slot_end: string;
}

async function getSpaBookingForNotification(hotelId: string, bookingId: string, supabase: SupabaseClient): Promise<PrivateSpaBookingForNotification | null> {
  const { data, error } = await supabase
    .from("spa_bookings")
    .select("id, hotel_id, status, guest_name, guest_phone_e164, party_size, booking_date, slot_start, slot_end")
    .eq("id", bookingId)
    .eq("hotel_id", hotelId)
    .maybeSingle<PrivateSpaBookingForNotification>();
  if (error) throw new Error(error.message);
  return data;
}

async function getSpaAdminPhone(hotelId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("hotel_spa_settings")
    .select("whatsapp_admin_phone_e164")
    .eq("hotel_id", hotelId)
    .maybeSingle<{ whatsapp_admin_phone_e164: string | null }>();
  if (error) throw new Error(error.message);
  return data?.whatsapp_admin_phone_e164 ?? null;
}

async function getHotelName(hotelId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("hotels").select("name").eq("id", hotelId).maybeSingle<{ name: string }>();
  if (error) throw new Error(error.message);
  return data?.name ?? null;
}

/** First word only — same "never the guest's full name to a third party" discipline as sendPartnerRequest.ts's own firstNameOnly, applied here even though the recipient IS this hotel's own staff, for consistency. */
function firstNameOnly(guestName: string | null): string | null {
  const trimmed = guestName?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

function formatSlotTime(value: string): string {
  return value.slice(0, 5);
}

export interface PreparedSpaBookingApprovalTemplate {
  requestPhoneE164: string;
  templateName: string;
  languageCode: string;
  bodyParams: string[];
}

export type PrepareSpaBookingApprovalResult = { ok: true; prepared: PreparedSpaBookingApprovalTemplate } | { ok: false; error: SpaBookingApprovalPreSendError };

export interface PrepareSpaBookingApprovalDeps {
  supabase?: SupabaseClient;
}

/**
 * All eligibility checks + the template's business content — NO network
 * call. Deliberately NEVER includes guest_phone_e164 in bodyParams even
 * though the admin needs it to call the guest back — the phone IS included,
 * but only ever passed as a plain body param value (never logged, never
 * part of a token/URL), same as every other business fact here.
 */
export async function prepareWhatsAppSpaBookingApproval(
  bookingId: string,
  hotelId: string,
  deps: PrepareSpaBookingApprovalDeps = {}
): Promise<PrepareSpaBookingApprovalResult> {
  const supabase = deps.supabase ?? createAdminClient();

  const booking = await getSpaBookingForNotification(hotelId, bookingId, supabase);
  if (!booking || booking.status !== "pending_approval") return { ok: false, error: "booking_not_eligible" };

  const adminPhone = await getSpaAdminPhone(hotelId, supabase);
  if (!adminPhone) return { ok: false, error: "missing_phone" };
  if (!E164_PATTERN.test(adminPhone)) return { ok: false, error: "invalid_phone" };

  const templateName = process.env[SPA_BOOKING_APPROVAL_TEMPLATE_ENV];
  if (!templateName) return { ok: false, error: "template_not_configured" };

  const hotelName = await getHotelName(hotelId, supabase);
  if (!hotelName) return { ok: false, error: "booking_not_eligible" };

  const bodyParams = [
    hotelName,
    booking.booking_date,
    `${formatSlotTime(booking.slot_start)} - ${formatSlotTime(booking.slot_end)}`,
    String(booking.party_size),
    firstNameOnly(booking.guest_name) ?? "—",
    booking.guest_phone_e164 ?? "—",
  ];

  return {
    ok: true,
    prepared: { requestPhoneE164: adminPhone, templateName, languageCode: TEMPLATE_LANGUAGE_CODE, bodyParams },
  };
}

export interface SpaBookingApprovalReplyButtonTokens {
  accept: string;
  reject: string;
}

export interface SendPreparedSpaBookingApprovalDeps {
  provider?: WhatsAppProvider;
}

/**
 * The ONLY place a spa-booking-approval WhatsApp template message actually
 * leaves this server. `replyTokens` are the RAW opaque tokens — generated
 * by, and whose hashes are already durably persisted by, the caller
 * (features/spa/deliveryService.ts) BEFORE this function is ever invoked.
 */
export async function sendPreparedSpaBookingApprovalTemplate(
  prepared: PreparedSpaBookingApprovalTemplate,
  replyTokens: SpaBookingApprovalReplyButtonTokens,
  deps: SendPreparedSpaBookingApprovalDeps = {}
): Promise<WhatsAppSendResult> {
  const provider = deps.provider ?? getWhatsAppProvider();

  return provider.sendTemplateMessage({
    toE164: prepared.requestPhoneE164,
    templateName: prepared.templateName,
    languageCode: prepared.languageCode,
    bodyParams: prepared.bodyParams,
    buttons: [
      { label: "Confirmer", payload: replyTokens.accept },
      { label: "Refuser", payload: replyTokens.reject },
    ],
  });
}
