import { createAdminClient } from "@/lib/supabase/admin";
import { hashConsentToken } from "./consentToken";

export interface PartnerConsentRequest {
  partnerName: string;
  hotelName: string;
  /** Always fresh at read time — "pending" is the only status the confirmation buttons should ever be shown for. */
  status: "not_requested" | "pending" | "accepted" | "declined";
  /**
   * Current value, if the hotel already filled/generated one — shown
   * pre-filled on the public consent page so the partner can confirm or
   * correct it rather than re-type from scratch. Null when nothing is set
   * yet (e.g. the partner has no website to generate it from), in which
   * case it's the partner's own opportunity to fill it in for the first
   * time — see acceptPartnerConsent's own doc comment.
   */
  openingHours: string | null;
  /** Same pre-fill/second-chance logic as openingHours above — see 0019_hotel_partner_consent_address_grant.sql's own comment. */
  address: string | null;
}

/**
 * Public, unauthenticated lookup for src/app/partenaires/consentement/page.tsx —
 * called with the raw token from the URL's ?token= query param, hashed
 * here before ever touching the database (never a plaintext comparison,
 * never logged). Uses service_role (createAdminClient()) since an
 * anonymous partner has no session — same posture as
 * features/partners/consentActions.ts's write side.
 *
 * Returns null for an unknown/invalid token — the page renders the same
 * generic "lien invalide" message either way, never distinguishing "wrong
 * token" from "token for a partner that no longer exists" (nothing
 * sensitive to enumerate here, but no reason to be more specific than
 * necessary either).
 */
export async function getPartnerConsentRequest(token: string): Promise<PartnerConsentRequest | null> {
  if (!token) return null;

  const tokenHash = hashConsentToken(token);
  const supabase = createAdminClient();

  // Two plain queries, joined in JS, rather than a nested PostgREST select —
  // same shape features/hotelUsers/queries.ts's own doc comment recommends:
  // simpler to reason about than guessing whether an embedded to-one
  // relationship resolves to an object or a single-element array.
  const { data: partner, error: partnerError } = await supabase
    .from("hotel_partners")
    .select("name, hotel_id, consent_status, opening_hours, address")
    .eq("consent_token_hash", tokenHash)
    .maybeSingle<{
      name: string;
      hotel_id: string;
      consent_status: PartnerConsentRequest["status"];
      opening_hours: string | null;
      address: string | null;
    }>();

  if (partnerError || !partner) {
    if (partnerError) console.error("getPartnerConsentRequest: partner lookup failed", { message: partnerError.message });
    return null;
  }

  const { data: hotel, error: hotelError } = await supabase
    .from("hotels")
    .select("name")
    .eq("id", partner.hotel_id)
    .maybeSingle<{ name: string }>();

  if (hotelError || !hotel) {
    if (hotelError) console.error("getPartnerConsentRequest: hotel lookup failed", { message: hotelError.message });
    return null;
  }

  return {
    partnerName: partner.name,
    hotelName: hotel.name,
    status: partner.consent_status,
    openingHours: partner.opening_hours,
    address: partner.address,
  };
}
