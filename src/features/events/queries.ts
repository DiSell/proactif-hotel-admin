import type { SupabaseClient } from "@supabase/supabase-js";
import type { HotelEvent } from "@/types/database";

/**
 * Session-bound read — RLS (0032_hotel_events.sql) is the real gate:
 * "superadmin full access" or "hotel_admin can select own hotel_events".
 * Deliberately performs NO authorization itself, same discipline as
 * features/partners/queries.ts — callers must have already authorized
 * hotelId (requireClientAccess() for the client portal, requireSuperadmin()
 * for the back-office) before calling this. The explicit `.eq("hotel_id",
 * hotelId)` is defense in depth on top of RLS, not a substitute for it.
 *
 * `supabase` is REQUIRED — no default — because back-office and the client
 * portal use different session cookies (lib/supabase/cookieScope.ts), same
 * reasoning as listHotelPartners.
 *
 * Returns EVERY event (active or not, past or future) — the management UI
 * computes its own display state (Actif / Futur / Expiré / Désactivé) from
 * is_active + starts_at/ends_at; the chatbot's own read path
 * (features/rag/events.ts) is separate and always filters server-side.
 */
export async function listHotelEvents(hotelId: string, supabase: SupabaseClient): Promise<HotelEvent[]> {
  const { data, error } = await supabase
    .from("hotel_events")
    .select("id, hotel_id, type, title, content, starts_at, ends_at, is_active, show_as_banner, created_at, updated_at")
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false })
    .returns<HotelEvent[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}
