import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSmsProvider } from "./provider";
import type { SmsProvider, SmsSendResult } from "./types";

/**
 * SMS content builder for spa-booking approval — mirrors
 * whatsapp/sendSpaBookingApproval.ts's own split. Strictly 2 options
 * (Confirmer/Refuser) — a spa booking has no "propose an alternative"
 * concept, and none is added here (audited and explicitly validated this
 * session: "aucune alternative ajoutée au SPA").
 */

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

export type SmsSpaBookingApprovalPreSendError = "booking_not_eligible" | "missing_phone" | "invalid_phone";

interface PrivateSpaBookingForSmsNotification {
  id: string;
  hotel_id: string;
  status: string;
  guest_name: string | null;
  party_size: number;
  booking_date: string;
  slot_start: string;
  slot_end: string;
}

async function getSpaBookingForSmsNotification(hotelId: string, bookingId: string, supabase: SupabaseClient): Promise<PrivateSpaBookingForSmsNotification | null> {
  const { data, error } = await supabase
    .from("spa_bookings")
    .select("id, hotel_id, status, guest_name, party_size, booking_date, slot_start, slot_end")
    .eq("id", bookingId)
    .eq("hotel_id", hotelId)
    .maybeSingle<PrivateSpaBookingForSmsNotification>();
  if (error) throw new Error(error.message);
  return data;
}

/** Reused as-is per this session's own audit conclusion: no schema change required to repurpose this phone field for SMS — a dedicated rename/generalization was flagged as a future, non-blocking consideration, not built here. */
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

function firstNameOnly(guestName: string | null): string | null {
  const trimmed = guestName?.trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0];
}

function formatSlotTime(value: string): string {
  return value.slice(0, 5);
}

export interface PreparedSpaBookingApprovalSms {
  requestPhoneE164: string;
  hotelName: string;
  bookingDate: string;
  slotStart: string;
  slotEnd: string;
  partySize: number;
  guestFirstName: string | null;
}

export type PrepareSmsSpaBookingApprovalResult = { ok: true; prepared: PreparedSpaBookingApprovalSms } | { ok: false; error: SmsSpaBookingApprovalPreSendError };

export interface PrepareSmsSpaBookingApprovalDeps {
  supabase?: SupabaseClient;
}

export async function prepareSmsSpaBookingApproval(
  bookingId: string,
  hotelId: string,
  deps: PrepareSmsSpaBookingApprovalDeps = {}
): Promise<PrepareSmsSpaBookingApprovalResult> {
  const supabase = deps.supabase ?? createAdminClient();

  const booking = await getSpaBookingForSmsNotification(hotelId, bookingId, supabase);
  if (!booking || booking.status !== "pending_approval") return { ok: false, error: "booking_not_eligible" };

  const adminPhone = await getSpaAdminPhone(hotelId, supabase);
  if (!adminPhone) return { ok: false, error: "missing_phone" };
  if (!E164_PATTERN.test(adminPhone)) return { ok: false, error: "invalid_phone" };

  const hotelName = await getHotelName(hotelId, supabase);
  if (!hotelName) return { ok: false, error: "booking_not_eligible" };

  return {
    ok: true,
    prepared: {
      requestPhoneE164: adminPhone,
      hotelName,
      bookingDate: booking.booking_date,
      slotStart: formatSlotTime(booking.slot_start),
      slotEnd: formatSlotTime(booking.slot_end),
      partySize: booking.party_size,
      guestFirstName: firstNameOnly(booking.guest_name),
    },
  };
}

/** Strictly 2 reply lines — digit 3 does not exist for spa. */
export function buildSpaBookingApprovalSmsBody(prepared: PreparedSpaBookingApprovalSms, code: string): string {
  const lines = [
    `${prepared.hotelName} — Nouvelle demande Spa`,
    `${prepared.bookingDate} ${prepared.slotStart}-${prepared.slotEnd}`,
    `${prepared.partySize} personnes`,
  ];
  if (prepared.guestFirstName) lines.push(`Client : ${prepared.guestFirstName}`);
  lines.push("", "Répondez :", `1 ${code} = confirmer`, `2 ${code} = refuser`);
  return lines.join("\n");
}

export interface SendPreparedSpaBookingApprovalSmsDeps {
  provider?: SmsProvider;
}

export async function sendPreparedSpaBookingApprovalSms(
  prepared: PreparedSpaBookingApprovalSms,
  code: string,
  deps: SendPreparedSpaBookingApprovalSmsDeps = {}
): Promise<SmsSendResult> {
  const provider = deps.provider ?? getSmsProvider();
  return provider.sendSms({ toE164: prepared.requestPhoneE164, body: buildSpaBookingApprovalSmsBody(prepared, code) });
}
