import type { SupabaseClient } from "@supabase/supabase-js";
import type { HotelMediaCategory } from "@/types/database";

export interface HotelMediaGalleryPhoto {
  url: string;
  alt: string | null;
}

/**
 * hotel_media equivalent of features/rag/roomPhotos.ts::loadSelectedRoomPhotos
 * — same three filters (hotel_id / category / is_selected), same order
 * (position ascending), same minimal projection (photo_url, alt_text only).
 * No fallback to a different category ever happens here: a category with
 * zero selected photos simply returns an empty array. Turning that into
 * "no gallery at all" (never a substitute category) is the caller's job —
 * see answer.ts's own hotelMediaGallery computation.
 */
export async function loadSelectedHotelMediaPhotos(
  supabase: SupabaseClient,
  hotelId: string,
  category: HotelMediaCategory
): Promise<HotelMediaGalleryPhoto[]> {
  const { data: photos } = await supabase
    .from("hotel_media")
    .select("photo_url, alt_text")
    .eq("hotel_id", hotelId)
    .eq("category", category)
    .eq("is_selected", true)
    .order("position", { ascending: true });

  return (photos ?? []).map((p) => ({ url: p.photo_url as string, alt: p.alt_text as string | null }));
}

/**
 * One regex list per category — mirrors features/rag/partners.ts's own
 * CATEGORY_KEYWORDS/detectRelevantPartnerCategory shape exactly. "other" is
 * deliberately excluded: a generic catch-all category is never auto-targeted
 * from free text, only ever set by hand in the back-office.
 *
 * Collision handling (see this conversation's own audit — "ATTENTION AUX
 * COLLISIONS"):
 * - "extérieur de l'hôtel" / "devant de l'hôtel" must target facade, not the
 *   generic exterior category — exterior's own bare "extérieur" pattern
 *   excludes that phrase via a negative lookahead, and facade has the
 *   specific compound pattern instead.
 * - "réception" alone is ambiguous between a wedding reception and the
 *   hotel's own front desk — wedding's pattern excludes "réception de
 *   l'hôtel/l'établissement" via the same negative-lookahead technique,
 *   and common_area has the specific compound pattern instead. This makes
 *   both pairs order-independent: whichever category is checked first can
 *   never wrongly win the other's more specific phrase.
 */
const CATEGORY_KEYWORDS: Record<Exclude<HotelMediaCategory, "other">, RegExp[]> = {
  pool: [/\bpiscines?\b/i],
  spa: [/\bspa\b/i, /\bespace\s+bien.?[êe]tre\b/i, /\bespace\s+d[ée]tente\b/i],
  sauna: [/\bsaunas?\b/i],
  hammam: [/\bhammams?\b/i],
  jacuzzi: [/\bjacuzzis?\b/i],
  fitness: [/\bsalle\s+de\s+sport\b/i, /\bfitness\b/i],
  exterior: [/\bparcs?\b/i, /\bjardins?\b/i, /\bext[ée]rieur\b(?!\s+de\s+l['’]?(h[ôo]tel|[ée]tablissement))/i],
  breakfast: [/\bpetits?[\s-]?d[ée]jeuners?\b/i],
  restaurant: [/\brestaurants?\b/i, /\brestauration\b/i],
  seminar: [/\bs[ée]minaires?\b/i, /\br[ée]unions?\b/i],
  wedding: [/\bmariages?\b/i, /\br[ée]ceptions?\b(?!\s+de\s+l['’]?(h[ôo]tel|[ée]tablissement))/i],
  chapel: [/\bchapelles?\b/i],
  facade: [/\bfa[çc]ades?\b/i, /\bext[ée]rieur\s+de\s+l['’]?(h[ôo]tel|[ée]tablissement)\b/i, /\bdevant\s+de\s+l['’]?h[ôo]tel\b/i],
  common_area: [/\bespaces?\s+communs?\b/i, /\bhall\b/i, /\br[ée]ception\s+de\s+l['’]?(h[ôo]tel|[ée]tablissement)\b/i],
  parking: [/\bparkings?\b/i],
};

/**
 * Best-effort category guess from the raw message — first match wins, null
 * when nothing matches. Deterministic only: the LLM never chooses the
 * category (see this conversation's own audit, point 2).
 */
export function detectHotelMediaCategory(message: string): HotelMediaCategory | null {
  for (const [category, patterns] of Object.entries(CATEGORY_KEYWORDS) as [Exclude<HotelMediaCategory, "other">, RegExp[]][]) {
    if (patterns.some((pattern) => pattern.test(message))) return category;
  }
  return null;
}

const PHOTO_REQUEST_PATTERNS: RegExp[] = [
  /\bmontrez?[\s-]moi\b/i,
  /\bmontrer\b/i,
  /\bvoir\s+(la|le|les|l['’])/i,
  /\bphotos?\b/i,
  /[àa]\s+quoi\s+ressemble/i,
  /\bshow\s+me\b/i,
  /\bpictures?\b/i,
];

/**
 * A bare factual question ("avez-vous une piscine ?") must never trigger a
 * gallery — only an explicit visual/photo request does. See this
 * conversation's own audit: "une simple question factuelle ... ne doit PAS
 * obligatoirement déclencher une galerie."
 */
export function isHotelMediaPhotoRequest(message: string): boolean {
  return PHOTO_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}
