import type { SupabaseClient } from "@supabase/supabase-js";
import type { HotelPartner } from "@/types/database";

/**
 * Session-bound read — RLS (0015_hotel_partners.sql) is the real gate:
 * "superadmin full access" or "hotel_admin can select own hotel_partners".
 * Deliberately performs NO authorization itself, same discipline as
 * features/photos/queries.ts — callers must have already authorized
 * hotelId (requireClientAccess() for the client portal, requireSuperadmin()
 * + getHotel(id) for the back-office) before calling this. The explicit
 * `.eq("hotel_id", hotelId)` is defense in depth on top of RLS, not a
 * substitute for it.
 *
 * `supabase` is REQUIRED — no default, no fallback — because back-office
 * and the client portal use different session cookies
 * (lib/supabase/cookieScope.ts), and this shared function has no way to
 * know on its own which one its caller actually authenticated under.
 * /etablissements/[id]/partenaires/page.tsx passes createClient()
 * (back-office); src/app/client/partners/page.tsx passes
 * createClientPortalClient().
 *
 * Returns EVERY partner (active or not) — the management UI needs to show
 * and toggle inactive ones too; the chatbot's own read path
 * (features/rag/partners.ts:loadPartnerCandidates) is separate and always
 * filters to is_active = true AND consent_status = 'accepted'.
 *
 * Explicit column list, never `select("*")` — this result is passed
 * straight through to PartnersManager.tsx/PartnerFormModal.tsx (Client
 * Components), which serializes it to the browser. `consent_token_hash`
 * (0017_hotel_partner_consent.sql) must never reach the browser even as a
 * hash — it has no reason to be there, and HotelPartner's own TypeScript
 * type deliberately doesn't declare it either.
 *
 * request_phone_e164 (0020_partner_requests.sql) IS included here on
 * purpose: this projection feeds ONLY the authorized hotel_admin/superadmin
 * management UI (PartnerFormModal.tsx), never the chatbot — the chatbot's
 * own, entirely separate read (features/rag/partners.ts:loadActiveHotelPartners)
 * never selects or forwards this column to the model/widget. Never confuse
 * the two: this constant must never be reused as, or merged into, a
 * chatbot-facing projection.
 *
 * whatsapp_consent_status/whatsapp_consent_requested_at/whatsapp_consent_responded_at
 * (0022_partner_transactional_consent.sql) follow the exact same rule as
 * their recommendation-consent counterparts: included for display in the
 * management UI, `whatsapp_consent_token_hash` deliberately excluded, same
 * discipline as `consent_token_hash`.
 */
const PARTNER_COLUMNS =
  "id, hotel_id, name, category, description, address, phone, request_phone_e164, opening_hours, website_url, booking_url, email, consent_status, consent_requested_at, consent_responded_at, whatsapp_consent_status, whatsapp_consent_requested_at, whatsapp_consent_responded_at, is_active, priority, created_at, updated_at";

export async function listHotelPartners(hotelId: string, supabase: SupabaseClient): Promise<HotelPartner[]> {
  const { data, error } = await supabase
    .from("hotel_partners")
    .select(PARTNER_COLUMNS)
    .eq("hotel_id", hotelId)
    .order("priority", { ascending: false })
    .order("name", { ascending: true })
    .returns<HotelPartner[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}
