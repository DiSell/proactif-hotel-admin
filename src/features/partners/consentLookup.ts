import { createAdminClient } from "@/lib/supabase/admin";
import { hashConsentToken } from "./consentToken";
import type { HotelPartnerConsentStatus } from "@/types/database";

interface PartnerConsentRow {
  name: string;
  hotel_id: string;
  consent_status: HotelPartnerConsentStatus;
  opening_hours: string | null;
  address: string | null;
  whatsapp_consent_status: HotelPartnerConsentStatus;
  request_phone_e164: string | null;
}

const PARTNER_CONSENT_ROW_COLUMNS = "name, hotel_id, consent_status, opening_hours, address, whatsapp_consent_status, request_phone_e164";

export interface PartnerConsentRequests {
  partnerName: string;
  hotelName: string;
  /**
   * The chatbot-recommendation consent (0017_hotel_partner_consent.sql).
   * "pending" is the only status the public page should show Accept/Decline
   * buttons for; any other status is rendered as a plain status message.
   */
  recommendation: {
    status: HotelPartnerConsentStatus;
    /** Current value, if the hotel already filled/generated one — see acceptPartnerConsent's own doc comment. */
    openingHours: string | null;
    address: string | null;
  };
  /** The SEPARATE transactional WhatsApp consent (0022_partner_transactional_consent.sql) — fully independent status from recommendation above. */
  whatsapp: {
    status: HotelPartnerConsentStatus;
    /** The operational number this SPECIFIC consent is about — request_phone_e164, never the public `phone` column. */
    requestPhoneE164: string | null;
  };
}

/**
 * Public, unauthenticated lookup for src/app/partenaires/consentement/page.tsx —
 * called with the raw token from the URL's ?token= query param, hashed here
 * before ever touching the database (never a plaintext comparison, never
 * logged). Uses service_role (createAdminClient()) since an anonymous
 * partner has no session — same posture as
 * features/partners/consentActions.ts's write side.
 *
 * ONE token can resolve EITHER (or both) of two independent columns —
 * consent_token_hash and whatsapp_consent_token_hash — because
 * requestPartnerConsentsInternal (features/partners/actions.ts) writes the
 * SAME token hash into whichever of the two columns belongs to a consent
 * that was actually eligible for a (re)request at send time. This function
 * tries the recommendation column first, then the whatsapp column — two
 * plain queries, same "simpler to reason about than a combined OR filter"
 * discipline as the rest of this codebase (see
 * features/hotelUsers/queries.ts's own doc comment) — and returns the SAME
 * combined shape either way: the partner's row is the single source of
 * truth for BOTH statuses regardless of which column the token happened to
 * match. This never grants anything by itself: accepting/declining each
 * consent (consentActions.ts) is STILL scoped independently by its own
 * column and its own "pending" status — a token that only ever touched one
 * column can never move the other consent's status.
 *
 * Returns null for an unknown/invalid token — the page renders the same
 * generic "lien invalide" message either way, never distinguishing "wrong
 * token" from "token for a partner that no longer exists" (nothing
 * sensitive to enumerate here, but no reason to be more specific than
 * necessary either).
 */
export async function getPartnerConsentRequests(token: string): Promise<PartnerConsentRequests | null> {
  if (!token) return null;

  const tokenHash = hashConsentToken(token);
  const supabase = createAdminClient();

  const { data: byRecommendation, error: recommendationError } = await supabase
    .from("hotel_partners")
    .select(PARTNER_CONSENT_ROW_COLUMNS)
    .eq("consent_token_hash", tokenHash)
    .maybeSingle<PartnerConsentRow>();
  if (recommendationError) {
    console.error("getPartnerConsentRequests: recommendation lookup failed", { message: recommendationError.message });
    return null;
  }

  const partner =
    byRecommendation ??
    (await (async () => {
      const { data: byWhatsapp, error: whatsappError } = await supabase
        .from("hotel_partners")
        .select(PARTNER_CONSENT_ROW_COLUMNS)
        .eq("whatsapp_consent_token_hash", tokenHash)
        .maybeSingle<PartnerConsentRow>();
      if (whatsappError) {
        console.error("getPartnerConsentRequests: whatsapp lookup failed", { message: whatsappError.message });
        return null;
      }
      return byWhatsapp;
    })());

  if (!partner) return null;

  const { data: hotel, error: hotelError } = await supabase
    .from("hotels")
    .select("name")
    .eq("id", partner.hotel_id)
    .maybeSingle<{ name: string }>();

  if (hotelError || !hotel) {
    if (hotelError) console.error("getPartnerConsentRequests: hotel lookup failed", { message: hotelError.message });
    return null;
  }

  return {
    partnerName: partner.name,
    hotelName: hotel.name,
    recommendation: {
      status: partner.consent_status,
      openingHours: partner.opening_hours,
      address: partner.address,
    },
    whatsapp: {
      status: partner.whatsapp_consent_status,
      requestPhoneE164: partner.request_phone_e164,
    },
  };
}
