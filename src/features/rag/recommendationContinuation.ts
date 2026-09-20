/**
 * Persists "a personalized accommodation RECOMMENDATION conversation is
 * engaged" across turns — mirrors bookingIntentContinuation.ts /
 * spaBookingFlow.ts / roomDiscoveryContinuation.ts's own marker mechanism
 * exactly, applied to this fourth, narrower domain. A different invisible
 * character than all three, deliberately: the four domains stay
 * structurally independent (see roomDiscoveryContinuation.ts's own doc
 * comment for why).
 *
 * 3-INTENTIONS chantier (audit "AUDIT INTENTIONS HÉBERGEMENTS"): this used
 * to be a single mechanism (roomDiscoveryContinuation.ts) shared by every
 * accommodation-shaped turn. Split out because INFORMATION and CATALOGUE
 * never ask a question and therefore never need to persist anything across
 * turns — only RECOMMENDATION genuinely waits for a reply ("combien de
 * personnes ?"). Fixes the same class of bug roomDiscoveryContinuation.ts
 * originally fixed, narrowed to this one domain: "Quel logement me
 * conseillez-vous ?" (capacity unknown, asks "combien de personnes ?")
 * followed by "Nous sommes 4" carries no recommendation verb of its own —
 * isAccommodationRecommendationIntent alone could never recognize it as
 * still wanting a recommendation.
 */

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** 8x U+2060 WORD JOINER — zero-width in every renderer. Distinct from bookingIntentContinuation.ts's (U+2064), spaBookingFlow.ts's (U+2063) and roomDiscoveryContinuation.ts's (U+2062) own markers. */
const RECOMMENDATION_MARKER = "⁠".repeat(8);

/**
 * Finds the MOST RECENT assistant message in history and checks whether it
 * carries the marker — same scan-backwards discipline as the other three
 * markers.
 */
export function lastAssistantMessageIndicatesRecommendationContinuation(history: HistoryMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content.includes(RECOMMENDATION_MARKER);
  }
  return false;
}

/** Appends the invisible continuation marker — the ONLY place it's ever written. */
export function withRecommendationMarker(reply: string): string {
  return `${reply}\n${RECOMMENDATION_MARKER}`;
}
