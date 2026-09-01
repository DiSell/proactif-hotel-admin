import type { SupabaseClient } from "@supabase/supabase-js";
import type { HotelSpaSettings, SpaBooking } from "@/types/database";

/**
 * Session-bound reads for the CLIENT PORTAL management UI — RLS
 * (0033_hotel_spa_settings.sql/0034_spa_bookings.sql) is the real gate.
 * Deliberately perform NO authorization themselves, same discipline as
 * features/events/queries.ts/features/partners/queries.ts — callers must
 * have already authorized hotelId (via requireHotelAccess()) before calling
 * either of these. `supabase` is REQUIRED — no default — same reasoning as
 * every other query module here: back-office and the client portal use
 * different session cookies.
 *
 * Both THROW on error (unlike features/spa/booking.ts's chatbot-facing
 * reads, which never throw) — this is the management UI, mirroring
 * listHotelEvents/listHotelPartners' own convention. Every call site MUST
 * wrap these in the same try/catch degradation pattern added to
 * src/app/client/(portal)/chatbot/page.tsx after a real production
 * incident (listHotelEvents throwing with no try/catch crashed the whole
 * page) — that pattern is a permanent requirement, not specific to events.
 */
export async function getHotelSpaSettings(hotelId: string, supabase: SupabaseClient): Promise<HotelSpaSettings | null> {
  const { data, error } = await supabase
    .from("hotel_spa_settings")
    .select(
      "id, hotel_id, enabled, opens_at, closes_at, slot_duration_minutes, capacity_per_slot, price_per_person, allow_non_residents, advance_booking_days, min_notice_hours, approval_mode, whatsapp_admin_phone_e164, created_at, updated_at"
    )
    .eq("hotel_id", hotelId)
    .maybeSingle<HotelSpaSettings>();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Explicit column list — includes guest_name/guest_phone_e164, unlike
 * features/partnerRequests/queries.ts's own list-column exclusion: this is
 * the hotel's own admin view of its own guests' bookings (the reason it
 * exists is precisely so staff know who's coming and how to reach them), not
 * a third party's PII exposed for no operational reason.
 */
export async function listSpaBookings(hotelId: string, supabase: SupabaseClient): Promise<SpaBooking[]> {
  const { data, error } = await supabase
    .from("spa_bookings")
    .select(
      "id, hotel_id, conversation_id, guest_name, guest_phone_e164, party_size, is_non_resident, notes, booking_date, slot_start, slot_end, price_per_person_snapshot, status, cancelled_by, cancelled_at, responded_at, owner_notification_status, owner_notified_at, created_at, updated_at"
    )
    .eq("hotel_id", hotelId)
    .order("booking_date", { ascending: false })
    .order("slot_start", { ascending: false })
    .returns<SpaBooking[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}
