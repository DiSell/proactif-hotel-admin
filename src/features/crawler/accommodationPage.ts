/**
 * Generic, multilingual keywords for a page that is ITSELF about a specific
 * accommodation/room — not the hotel in general. Deliberately narrower than
 * RELEVANCE_KEYWORDS.rooms (config.ts, used only for crawl PRIORITIZATION,
 * never for inclusion/exclusion): this list exists specifically so
 * "hotel"/"spa"/"restaurant" etc. alone can never qualify a page as an
 * accommodation page — see isAccommodationPage's own doc comment.
 *
 * No hotel-specific word (no "le-crib", "le-snug", or any other slug),
 * no per-hotel exception, no OpenAI call — pure keyword matching on
 * url/title/headings, same idiom as classifyPageRelevance (relevance.ts).
 * Substring matching means singular forms already cover their plurals
 * ("chambre" matches "chambres", "room" matches "rooms") — no need to list
 * both, same convention already used by RELEVANCE_KEYWORDS.
 */
export const ACCOMMODATION_PAGE_KEYWORDS = [
  // FR
  "chambre", "suite", "studio", "appartement", "hebergement", "hébergement",
  // EN
  "room", "apartment", "accommodation",
  // ES
  "habitacion", "habitación", "alojamiento", "apartamento",
  // NL
  "kamer",
];

export interface AccommodationPageSignal {
  url: string;
  title: string;
}

/**
 * True only if the URL or the title contains one of
 * ACCOMMODATION_PAGE_KEYWORDS — a signal, not a certainty (same posture as
 * classifyPageRelevance: "never means the hotel has X, only that the page
 * is worth surfacing for a human to judge"). Used exclusively to curate
 * which pages feed the "Hébergements détectés" section
 * (AnalyzeSiteModal.tsx) — has no effect on which pages the crawler treats
 * as useful for the general RAG knowledge base (see hasImportableContent /
 * CrawlPageStatus), and no effect on classifyPageRelevance/looksTechnicalOnly.
 *
 * Deliberately does NOT also match against page headings, even though
 * they're available on CrawlPage — verified empirically against a real
 * crawl (chabanettes.com): a homepage matched via a "Nos Chambres" section
 * heading (defensible, if noisy) but a plain "Qui sommes-nous" bio page
 * ALSO matched, via an unrelated heading — "Services d'experts-conseils en
 * matière d'hôtellerie et d'hébergement" (a professional consulting
 * service, nothing to do with this hotel's own rooms). Since excluding
 * general editorial/about-us pages is an explicit, hard requirement here
 * (not just a nice-to-have), url+title alone — checked against the same
 * real data — correctly excludes both without missing any real
 * accommodation page found in that same run. Revisit only with new
 * evidence that url+title alone under-recalls in practice, not by
 * re-adding headings speculatively.
 *
 * A generic keyword match is still imprecise by nature even scoped this
 * way: a page whose title/URL happens to mention "hébergement" in an
 * unrelated sense (e.g. a "business for sale" listing describing the hotel
 * as a whole) can still match here — classifyAccommodationPage (below)
 * catches that specific case via its own EDITORIAL_OVERRIDE_KEYWORDS; this
 * function alone stays a broad, deliberately permissive first gate, not
 * the final word on whether a page becomes an accommodation_type.
 */
export function isAccommodationPage({ url, title }: AccommodationPageSignal): boolean {
  const haystack = `${url} ${title}`.toLowerCase();
  return ACCOMMODATION_PAGE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

/**
 * "1 accommodation page = 1 accommodation_type" is false — a hotel's own
 * pricing/overview/category page ("Nos Tarifs", "Les Chambres Doubles")
 * mentions room vocabulary just as much as a genuine single-room page
 * ("Le Studio", "Suite Deluxe"), and a page that only mentions
 * accommodation vocabulary in passing while describing something else
 * entirely (a "business for sale" listing) is not about a room at all.
 * classifyAccommodationPage distinguishes the three cases GENERICALLY,
 * from url/title alone — same posture as isAccommodationPage: a signal
 * for curation, not a certainty, always human-reviewable before save.
 *
 *   "detail"          — a page about ONE specific accommodation. Can
 *                        create/propose an accommodation_type.
 *   "listing"          — a category/pricing/overview page. Still useful
 *                        for the RAG knowledge base (unaffected — see
 *                        hasImportableContent, untouched by this function)
 *                        but must NEVER become an accommodation_type.
 *   "not_accommodation" — isAccommodationPage was false, OR an editorial/
 *                        business-description page that merely mentions
 *                        accommodation vocabulary without being about one.
 *
 * Order of checks, each generic and multilingual, none hotel-specific:
 *
 *   1. isAccommodationPage(url, title) — the existing gate; false here
 *      short-circuits straight to "not_accommodation".
 *   2. EDITORIAL_OVERRIDE_KEYWORDS ("qui sommes", "à vendre", "for sale"...)
 *      — an explicit override to "not_accommodation" even when an
 *      accommodation keyword also matched. Verified against a real crawl
 *      (chabanettes.com): a "hotel + restaurant + spa + hébergement
 *      touristique À VENDRE" business listing would otherwise slip through
 *      as a false "detail" page purely because "hébergement" appears in
 *      its own title.
 *   3. PLURAL_ACCOMMODATION_KEYWORDS ("chambres", "rooms", "suites"...) or
 *      LISTING_CONTEXT_KEYWORDS ("tarif", "price", "rate"...) — a plural
 *      form is a real morphological signal that the page covers MULTIPLE
 *      accommodations, not one; a pricing/rate word signals an overview,
 *      not a single room's own page. Either -> "listing".
 *   4. Otherwise -> "detail" (isAccommodationPage was true via a SINGULAR
 *      keyword, nothing overrode it, nothing marked it a listing).
 *
 * Deliberately NOT implemented: detecting "several distinct room names
 * enumerated in this page's headings" as an additional listing signal.
 * Considered, but every real page audited (chabanettes.com) already
 * classifies correctly through the four rules above; adding a "multiple
 * proper nouns" heuristic without a real case that needs it would be
 * speculative complexity, not a verified fix — revisit only with evidence.
 */
export type AccommodationPageClassification = "detail" | "listing" | "not_accommodation";

const EDITORIAL_OVERRIDE_KEYWORDS = [
  // FR
  "qui sommes", "notre histoire", "a vendre", "à vendre",
  // EN
  "who we are", "about us", "our story", "for sale",
];

const PLURAL_ACCOMMODATION_KEYWORDS = [
  // FR
  "chambres", "suites", "studios", "appartements", "hebergements", "hébergements",
  // EN
  "rooms", "apartments", "accommodations",
  // ES
  "habitaciones", "alojamientos", "apartamentos",
  // NL
  "kamers",
];

const LISTING_CONTEXT_KEYWORDS = [
  // FR
  "tarif", "tarifs", "prix",
  // EN
  "price", "pricing", "rate", "rates",
  // ES
  "precio", "precios",
];

export function classifyAccommodationPage({ url, title }: AccommodationPageSignal): AccommodationPageClassification {
  if (!isAccommodationPage({ url, title })) return "not_accommodation";

  const haystack = `${url} ${title}`.toLowerCase();
  if (EDITORIAL_OVERRIDE_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "not_accommodation";
  if (PLURAL_ACCOMMODATION_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "listing";
  if (LISTING_CONTEXT_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "listing";
  return "detail";
}
