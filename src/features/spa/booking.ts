import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email/sendEmail";
import { spaBookingNotificationTemplate } from "@/lib/email/templates/spaBookingNotification";
import { deliverSpaBookingApprovalRequest } from "./deliveryService";
import type { HotelSpaSettings, SpaBookingStatus } from "@/types/database";

/**
 * Chatbot-facing reads/writes — mirrors features/rag/events.ts's own split
 * from features/events/queries.ts: an independent, admin-client-defaulted,
 * NEVER-THROWING read path for the chat pipeline, kept separate from
 * queries.ts's throwing, session-bound reads used by the client-portal
 * management UI. A DB hiccup here must never break a chat turn.
 */

type PromptSpaSettingsRow = Pick<
  HotelSpaSettings,
  | "enabled"
  | "opens_at"
  | "closes_at"
  | "slot_duration_minutes"
  | "capacity_per_slot"
  | "price_per_person"
  | "allow_non_residents"
  | "advance_booking_days"
  | "min_notice_hours"
  | "approval_mode"
>;

async function getHotelSpaSettingsForChatbot(hotelId: string, supabase: SupabaseClient): Promise<PromptSpaSettingsRow | null> {
  const { data, error } = await supabase
    .from("hotel_spa_settings")
    .select("enabled, opens_at, closes_at, slot_duration_minutes, capacity_per_slot, price_per_person, allow_non_residents, advance_booking_days, min_notice_hours, approval_mode")
    .eq("hotel_id", hotelId)
    .maybeSingle<PromptSpaSettingsRow>();
  if (error) {
    console.error("getHotelSpaSettingsForChatbot: query failed", { hotelId, message: error.message });
    return null;
  }
  return data;
}

/** "HH:MM:SS" or "HH:MM" (Postgres `time`, however the driver serializes it) -> minutes since midnight. */
function timeToMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes: number): string {
  const hours = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const mins = (minutes % 60).toString().padStart(2, "0");
  return `${hours}:${mins}`;
}

export interface SpaAvailabilitySlot {
  slotStart: string;
  slotEnd: string;
  capacity: number;
  booked: number;
  free: number;
  /**
   * A "no point offering it" UX hint only — computed client-side from the
   * same rules create_spa_booking() enforces (0034_spa_bookings.sql), but
   * the RPC alone is the real authority at commit time (e.g. a slot that
   * looked bookable here can still fill up or fall outside the window by
   * the time the guest actually confirms).
   */
  bookable: boolean;
}

export interface SpaAvailability {
  enabled: boolean;
  date: string;
  pricePerPerson: number | null;
  allowNonResidents: boolean;
  /** "auto": a booking is confirmed immediately. "manual": a booking is created as pending_approval and the hotel must confirm/refuse it (0035_spa_booking_approval.sql) — the guest must never be told the booking is confirmed in this mode. */
  approvalMode: "auto" | "manual";
  slots: SpaAvailabilitySlot[];
}

const DISABLED_AVAILABILITY = (date: string): SpaAvailability => ({
  enabled: false,
  date,
  pricePerPerson: null,
  allowNonResidents: false,
  approvalMode: "auto",
  slots: [],
});

function isSlotBookable(dateIso: string, slotStartMinutes: number, settings: PromptSpaSettingsRow, nowMs: number): boolean {
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  const advanceLimitIso = new Date(nowMs + settings.advance_booking_days * 86_400_000).toISOString().slice(0, 10);
  if (dateIso < todayIso || dateIso > advanceLimitIso) return false;
  if (dateIso === todayIso) {
    const slotStartMs = Date.parse(`${dateIso}T${minutesToTime(slotStartMinutes)}:00.000Z`);
    if (slotStartMs < nowMs + settings.min_notice_hours * 3_600_000) return false;
  }
  return true;
}

/**
 * Never throws — same fail-safe discipline as features/rag/events.ts's
 * loadActiveHotelEvents/loadActiveBanner: a query failure degrades to "spa
 * booking unavailable this turn", never breaks the whole chat turn. Slot
 * boundaries are ALWAYS derived from settings.slot_duration_minutes — never
 * a hardcoded duration.
 */
export async function getSpaAvailability(
  hotelId: string,
  dateIso: string,
  supabase: SupabaseClient = createAdminClient(),
  nowMs: number = Date.now()
): Promise<SpaAvailability> {
  const settings = await getHotelSpaSettingsForChatbot(hotelId, supabase);
  if (!settings || !settings.enabled) return DISABLED_AVAILABILITY(dateIso);

  const { data: bookings, error } = await supabase
    .from("spa_bookings")
    .select("slot_start, party_size")
    .eq("hotel_id", hotelId)
    .eq("booking_date", dateIso)
    // pending_approval already occupies its slot's capacity, exactly like
    // create_spa_booking()'s own aggregate (0035_spa_booking_approval.sql)
    // — otherwise the chat could show a slot as free while a decision is
    // still pending on it.
    .in("status", ["confirmed", "pending_approval"])
    .returns<{ slot_start: string; party_size: number }[]>();

  if (error) {
    console.error("getSpaAvailability: bookings query failed", { hotelId, dateIso, message: error.message });
    return DISABLED_AVAILABILITY(dateIso);
  }

  const bookedBySlotStart = new Map<number, number>();
  for (const row of bookings ?? []) {
    const key = timeToMinutes(row.slot_start);
    bookedBySlotStart.set(key, (bookedBySlotStart.get(key) ?? 0) + row.party_size);
  }

  const opensMinutes = timeToMinutes(settings.opens_at);
  const closesMinutes = timeToMinutes(settings.closes_at);
  const slots: SpaAvailabilitySlot[] = [];
  for (let start = opensMinutes; start + settings.slot_duration_minutes <= closesMinutes; start += settings.slot_duration_minutes) {
    const booked = bookedBySlotStart.get(start) ?? 0;
    const capacity = settings.capacity_per_slot;
    slots.push({
      slotStart: minutesToTime(start),
      slotEnd: minutesToTime(start + settings.slot_duration_minutes),
      capacity,
      booked,
      free: Math.max(0, capacity - booked),
      bookable: capacity - booked > 0 && isSlotBookable(dateIso, start, settings, nowMs),
    });
  }

  return {
    enabled: true,
    date: dateIso,
    pricePerPerson: settings.price_per_person,
    allowNonResidents: settings.allow_non_residents,
    approvalMode: settings.approval_mode,
    slots,
  };
}

export type CreateSpaBookingErrorCode = "not_enabled" | "outside_window" | "invalid_slot" | "min_notice" | "non_resident_not_allowed" | "slot_full" | "error";

export type CreateSpaBookingResult = { ok: true; bookingId: string; status: Exclude<SpaBookingStatus, "cancelled"> } | { ok: false; code: CreateSpaBookingErrorCode };

export interface CreateSpaBookingParams {
  hotelId: string;
  conversationId: string;
  guestName: string | null;
  guestPhoneE164: string | null;
  partySize: number;
  isNonResident: boolean;
  notes: string | null;
  /** "YYYY-MM-DD" */
  bookingDate: string;
  /** "HH:MM" */
  slotStart: string;
}

/** SQLSTATE -> closed TS error code — see 0034_spa_bookings.sql section B's own doc comment for the full table this mirrors. */
const SQLSTATE_TO_ERROR_CODE: Record<string, CreateSpaBookingErrorCode> = {
  P1001: "not_enabled",
  P1002: "outside_window",
  P1003: "invalid_slot",
  P1004: "min_notice",
  P1005: "non_resident_not_allowed",
  P1006: "slot_full",
};

/**
 * Thin wrapper around the create_spa_booking() RPC — the ONLY place a
 * spa_bookings row is ever created from application code. On success, fires
 * the owner-notification email (best-effort — see notifySpaBookingOwner,
 * never fails the booking itself). On the idempotency unique index (23505 —
 * see 0034_spa_bookings.sql section A), re-reads and reuses the existing
 * confirmed booking instead of erroring, mirroring
 * createPartnerRequestForChatbot's own 23505 recovery — no re-notification
 * on that path, since the original creation already notified the owner.
 */
export async function createSpaBookingForChatbot(params: CreateSpaBookingParams, supabase: SupabaseClient = createAdminClient()): Promise<CreateSpaBookingResult> {
  const { data, error } = await supabase.rpc("create_spa_booking", {
    p_hotel_id: params.hotelId,
    p_conversation_id: params.conversationId,
    p_guest_name: params.guestName,
    p_guest_phone_e164: params.guestPhoneE164,
    p_party_size: params.partySize,
    p_is_non_resident: params.isNonResident,
    p_notes: params.notes,
    p_booking_date: params.bookingDate,
    p_slot_start: params.slotStart,
  });

  if (error) {
    if (error.code === "23505") {
      const { data: existing, error: rereadError } = await supabase
        .from("spa_bookings")
        .select("id, status")
        .eq("conversation_id", params.conversationId)
        .eq("booking_date", params.bookingDate)
        .eq("slot_start", params.slotStart)
        .in("status", ["confirmed", "pending_approval"])
        .maybeSingle<{ id: string; status: Exclude<SpaBookingStatus, "cancelled"> }>();
      if (!rereadError && existing) return { ok: true, bookingId: existing.id, status: existing.status };
    }

    const mapped = SQLSTATE_TO_ERROR_CODE[error.code ?? ""];
    if (mapped) return { ok: false, code: mapped };

    console.error("createSpaBookingForChatbot: rpc failed", { hotelId: params.hotelId, message: error.message });
    return { ok: false, code: "error" };
  }

  const bookingId = data as string;

  // The RPC only returns the new id — re-read the actual status it decided
  // (auto vs manual approval_mode) rather than re-deriving it from a
  // separately-fetched settings row, which could have changed between this
  // call and the RPC's own read.
  const { data: created } = await supabase.from("spa_bookings").select("status").eq("id", bookingId).maybeSingle<{ status: Exclude<SpaBookingStatus, "cancelled"> }>();
  const status: Exclude<SpaBookingStatus, "cancelled"> = created?.status ?? "confirmed";

  await notifySpaBookingOwner(
    bookingId,
    params.hotelId,
    { guestName: params.guestName, guestPhoneE164: params.guestPhoneE164, partySize: params.partySize, bookingDate: params.bookingDate, slotStart: params.slotStart, isNonResident: params.isNonResident, notes: params.notes, status },
    supabase
  );

  if (status === "pending_approval") {
    // Best-effort, never blocks the booking itself — the client-portal
    // Confirmer/Refuser buttons (SpaBookingsList.tsx) always work regardless
    // of whether WhatsApp is configured or this specific send succeeds.
    try {
      await deliverSpaBookingApprovalRequest(bookingId, params.hotelId, { supabase });
    } catch (err) {
      console.error("createSpaBookingForChatbot: WhatsApp approval delivery failed", { hotelId: params.hotelId, bookingId, message: (err as Error).message });
    }
  }

  return { ok: true, bookingId, status };
}

async function markSpaBookingNotification(bookingId: string, hotelId: string, status: "sent" | "failed", supabase: SupabaseClient): Promise<void> {
  const { error } = await supabase.rpc("mark_spa_booking_notification", { p_hotel_id: hotelId, p_booking_id: bookingId, p_status: status });
  if (error) {
    console.error("markSpaBookingNotification: rpc failed", { hotelId, bookingId, message: error.message });
  }
}

/**
 * Best-effort, own try/catch — a notification failure (missing contact
 * email, provider outage) never fails the booking itself, mirroring the
 * "never block on notification" discipline already established for
 * partner_requests.guest_notification_status. Sent to
 * chatbot_settings.handoff_email, falling back to hotels.email — the same
 * "who do we contact for human intervention" fields already configurable by
 * every hotel, no new contact-info field introduced for this feature.
 */
async function notifySpaBookingOwner(
  bookingId: string,
  hotelId: string,
  booking: {
    guestName: string | null;
    guestPhoneE164: string | null;
    partySize: number;
    bookingDate: string;
    slotStart: string;
    isNonResident: boolean;
    notes: string | null;
    status: Exclude<SpaBookingStatus, "cancelled">;
  },
  supabase: SupabaseClient
): Promise<void> {
  try {
    const [{ data: hotel }, { data: settings }] = await Promise.all([
      supabase.from("hotels").select("name, email").eq("id", hotelId).maybeSingle<{ name: string; email: string | null }>(),
      supabase.from("chatbot_settings").select("handoff_email").eq("hotel_id", hotelId).maybeSingle<{ handoff_email: string | null }>(),
    ]);

    const targetEmail = settings?.handoff_email || hotel?.email;
    if (!hotel || !targetEmail) {
      await markSpaBookingNotification(bookingId, hotelId, "failed", supabase);
      return;
    }

    const template = spaBookingNotificationTemplate({
      hotelName: hotel.name,
      guestName: booking.guestName,
      guestPhoneE164: booking.guestPhoneE164,
      partySize: booking.partySize,
      bookingDate: booking.bookingDate,
      slotStart: booking.slotStart,
      isNonResident: booking.isNonResident,
      notes: booking.notes,
      status: booking.status,
    });

    const result = await sendEmail({ to: targetEmail, subject: template.subject, html: template.html, text: template.text });
    await markSpaBookingNotification(bookingId, hotelId, result.ok ? "sent" : "failed", supabase);
  } catch (err) {
    console.error("notifySpaBookingOwner: failed", { hotelId, bookingId, message: (err as Error).message });
    try {
      await markSpaBookingNotification(bookingId, hotelId, "failed", supabase);
    } catch {
      // Best-effort on top of best-effort — never propagate.
    }
  }
}
