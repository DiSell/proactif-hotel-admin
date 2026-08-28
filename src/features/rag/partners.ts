import type { SupabaseClient } from "@supabase/supabase-js";
import type { HotelPartnerCategory } from "@/types/database";
import type { PartnerAction, PartnerRecommendation, RagPartner } from "./types";

/**
 * Never noyer le visiteur (product spec point 8): at most 3 partners in a
 * response by default. wantsAllPartners raises this to ALL_PARTNERS_LIMIT
 * only on an explicit "tous vos restaurants" / "all your ..." style
 * request — still a bounded sanity cap, never literally unlimited. Both
 * caps are enforced HERE, server-side, on the candidate list the model is
 * even shown — the model physically cannot recommend more than this many,
 * it never has to be trusted to respect a "max 3" instruction on its own.
 */
export const DEFAULT_PARTNER_LIMIT = 3;
export const ALL_PARTNERS_LIMIT = 20;

/**
 * Broad, multilingual, generic keyword net (FR/EN) — a false positive here
 * is cheap: it only means partner candidates get loaded and offered to the
 * model, which still only recommends any of them via recommendedPartnerIds
 * when genuinely relevant (see answer.ts, and buildPartnerGuidance in
 * prompt.ts, which explicitly tells it to leave the list empty otherwise).
 * A missed real intent is the worse failure mode, so this errs wide.
 */
const PARTNER_INTENT_PATTERNS: RegExp[] = [
  /\brestaurants?\b/i,
  /\bmanger\b|\bd[iî]ner\b|\bd[ée]jeuner\b|\bdinner\b|\bfood\b/i,
  /\btaxis?\b|\bvtc\b|\bnavette\b|\btransports?\b|\bgare\b|\ba[ée]roport\b|\bairport\b|\bcomment\s+(aller|se\s+rendre)\b/i,
  /\bactivit[ée]s?\b|\bexcursions?\b/i,
  /\bv[ée]lo\b|\bbikes?\b/i,
  /\bguides?\b/i,
  /\bboutiques?\b|\bcommerces?\b|\bshops?\b|\bmagasins?\b/i,
  /\bproducteurs?\b|\bproduits?\s+locaux?\b|\blocal\s+products?\b/i,
  /\bbien.?[êe]tre\b|\bspa\b|\bmassages?\b|\bwellness\b/i,
  /\blocations?\b|\brentals?\b|\blouer\b|\brent\b/i,
  /\bpartenaires?\b|\bpartners?\b/i,
  /\brecommand/i,
  /\bconseill/i,
  /\bo[uù]\s+(puis-je|peut-on|aller)\b/i,
  /\bque\s+(peut-on|faire)\b/i,
  /\bautour\s+de\s+l.?h[oô]tel\b/i,
  /\bwhere\s+can\s+i\b/i,
  /\bwhat\s+to\s+do\b/i,
  /\bnearby\b/i,
];

/** Independent of groundingMode/RAG — same discipline as answer.ts's isBookingIntent: a pure regex check on the raw message, cheap enough to always run. */
export function isPartnerIntent(message: string): boolean {
  return PARTNER_INTENT_PATTERNS.some((pattern) => pattern.test(message));
}

const CATEGORY_KEYWORDS: Record<Exclude<HotelPartnerCategory, "other">, RegExp[]> = {
  restaurant: [/\brestaurants?\b/i, /\bmanger\b/i, /\bd[iî]ner\b/i, /\bd[ée]jeuner\b/i, /\bdinner\b/i, /\bfood\b/i],
  transport: [/\btaxis?\b/i, /\bvtc\b/i, /\bnavette\b/i, /\btransports?\b/i, /\bgare\b/i, /\ba[ée]roport\b/i, /\bairport\b/i, /\bstation\b/i],
  activity: [/\bactivit[ée]s?\b/i, /\bexcursions?\b/i, /\bvisites?\s+guid[ée]e/i, /\bthings?\s+to\s+do\b/i],
  wellness: [/\bbien.?[êe]tre\b/i, /\bspa\b/i, /\bmassages?\b/i, /\bwellness\b/i],
  shopping: [/\bboutiques?\b/i, /\bcommerces?\b/i, /\bshops?\b/i, /\bshopping\b/i, /\bmagasins?\b/i],
  local_product: [/\bproducteurs?\b/i, /\bproduits?\s+locaux?\b/i, /\blocal\s+products?\b/i, /\bmarch[ée]\b/i],
  guide: [/\bguides?\b/i],
  rental: [/\bv[ée]lo\b/i, /\bbikes?\b/i, /\blocations?\b/i, /\brentals?\b/i, /\blouer\b/i, /\brent\b/i],
};

/**
 * Best-effort category guess from the raw message — null when nothing
 * matches a specific category (a general "que peut-on faire autour de
 * l'hôtel ?" is deliberately category-agnostic). See rankPartnerCandidates
 * for how this is actually applied (with a fallback when the guess yields
 * zero active partners, so a keyword miss never hides an otherwise-relevant
 * partner in a different category).
 */
export function detectRelevantPartnerCategory(message: string): HotelPartnerCategory | null {
  for (const [category, patterns] of Object.entries(CATEGORY_KEYWORDS) as [Exclude<HotelPartnerCategory, "other">, RegExp[]][]) {
    if (patterns.some((pattern) => pattern.test(message))) return category;
  }
  return null;
}

const EXPLICIT_ALL_PATTERNS: RegExp[] = [
  /\btous\s+(vos|les)\b/i,
  /\btoutes\s+(vos|les)\b/i,
  /\ball\s+your\b/i,
  /\bevery\s+/i,
  /\bla\s+liste\s+compl[eè]te\b/i,
  /\bthe\s+full\s+list\b/i,
];

/** "quels sont tous vos restaurants partenaires ?" -> raise the cap to ALL_PARTNERS_LIMIT — see DEFAULT_PARTNER_LIMIT's own comment. */
export function wantsAllPartners(message: string): boolean {
  return EXPLICIT_ALL_PATTERNS.some((pattern) => pattern.test(message));
}

export interface RankPartnerCandidatesOptions {
  category: HotelPartnerCategory | null;
  limit: number;
}

/**
 * priority DESC, then name ASC — the ONLY ordering rule (no scoring
 * algorithm, per the product spec). Always filters to is_active itself —
 * defensive: the caller's own query (loadActiveHotelPartners below)
 * already filters at the DB level, but this pure function must never
 * present an inactive partner even if handed one directly (e.g. a test
 * fixture, or a future caller that forgets the DB-level filter).
 */
export function rankPartnerCandidates(partners: RagPartner[], options: RankPartnerCandidatesOptions): RagPartner[] {
  const active = partners.filter((partner) => partner.is_active);
  const byCategory = options.category ? active.filter((partner) => partner.category === options.category) : active;
  const pool = byCategory.length > 0 ? byCategory : active;

  return [...pool].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name)).slice(0, options.limit);
}

/**
 * The ONLY place a partner CTA is decided — mirrors buildBookingAction's
 * discipline in answer.ts: never something the model produces, always
 * derived straight from the database row. booking_url takes priority over
 * website_url (product spec point 10); neither present -> null, never a
 * fabricated link.
 */
export function buildPartnerAction(partner: Pick<RagPartner, "booking_url" | "website_url">): PartnerAction | null {
  if (partner.booking_url) return { type: "partner_booking", label: "Réserver", url: partner.booking_url };
  if (partner.website_url) return { type: "partner_website", label: "Voir le site", url: partner.website_url };
  return null;
}

export function toPartnerRecommendation(partner: RagPartner): PartnerRecommendation {
  return {
    id: partner.id,
    name: partner.name,
    category: partner.category,
    description: partner.description,
    address: partner.address,
    phone: partner.phone,
    openingHours: partner.opening_hours,
    websiteUrl: partner.website_url,
    bookingUrl: partner.booking_url,
    action: buildPartnerAction(partner),
  };
}

/**
 * Explicit, minimal column list — never `select("*")`. Every column here was
 * traced as genuinely read somewhere in the RAG pipeline (rankPartnerCandidates/
 * buildPartnerAction/toPartnerRecommendation above, buildPartnerGuidance/
 * buildPartnerRequestGuidance in prompt.ts, partnerRequestFlow.ts) — see
 * RagPartner's own doc comment (features/rag/types.ts). Deliberately EXCLUDES
 * every operational/internal column this pipeline never needs, in
 * particular: request_phone_e164 (private WhatsApp-routing number,
 * 0020_partner_requests.sql — must never reach the model/widget), email,
 * consent_token_hash, consent_status/consent_requested_at/consent_responded_at
 * (the consent gate itself is enforced by the WHERE clause below, not by
 * reading the column back), created_at/updated_at. A `select("*")` here
 * would silently start loading any future sensitive column a later
 * migration adds to hotel_partners — this explicit list can't.
 *
 * hotel_id-, is_active-, and consent_status-scoped read — the ONLY place
 * answer.ts reads hotel_partners from. Never touched by accommodation_types/
 * room_photos/knowledge_sources logic, and never feeds the RAG knowledge
 * base (product spec point 11) — this is a wholly separate read path.
 *
 * consent_status = "accepted" (0017_hotel_partner_consent.sql) is a SECOND,
 * independent gate on top of is_active — the hotel's own on/off toggle
 * never bypasses the partner's own confirmation. A partner is_active but
 * still "not_requested"/"pending"/"declined" must never be recommended by
 * the chatbot, no matter how it's ranked or filtered downstream. Filtered
 * entirely at the SQL level (WHERE clause) — never selected as a returned
 * column, since nothing downstream ever reads it back.
 */
const RAG_PARTNER_COLUMNS =
  "id, hotel_id, name, category, description, address, phone, opening_hours, website_url, booking_url, is_active, priority";

export async function loadActiveHotelPartners(supabase: SupabaseClient, hotelId: string): Promise<RagPartner[]> {
  const { data, error } = await supabase
    .from("hotel_partners")
    .select(RAG_PARTNER_COLUMNS)
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .eq("consent_status", "accepted")
    .returns<RagPartner[]>();
  if (error) {
    console.error("loadActiveHotelPartners: query failed", { hotelId, message: error.message });
    return [];
  }
  return data ?? [];
}
