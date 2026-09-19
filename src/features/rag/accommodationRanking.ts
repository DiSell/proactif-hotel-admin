import type { PartySize } from "./partySize";

/**
 * A hotel's accommodation type as known to the ranking step — deliberately
 * minimal, just the fields capacity filtering needs.
 */
export interface AccommodationCandidate {
  id: string;
  name: string;
  maxGuests: number | null;
  maxAdults: number | null;
  maxChildren: number | null;
}

/**
 * "known" = at least one capacity field is on file and this candidate is
 * confirmed compatible with the request — safe to present as a genuine
 * best-fit candidate. "unknown" = capacity isn't reliably known at all
 * (every field null), so it must never be presented as "the best fit" —
 * only as an option to verify. See buildAccommodationGuidance in prompt.ts
 * for how this distinction is communicated to the model.
 */
export type AccommodationFit = "known" | "unknown";

export interface RankedCandidate extends AccommodationCandidate {
  fit: AccommodationFit;
}

/**
 * Business capacity rule, independent of any actual availability check
 * (see src/features/availability/): a candidate is incompatible the moment
 * ANY known ceiling is exceeded — adults alone, children alone, or the
 * combined total. A null ceiling never excludes: "unknown" is not "zero"
 * and never "unlimited" either, it's simply not evaluated for that field.
 */
export function isCapacityCompatible(
  accommodationType: { maxGuests: number | null; maxAdults: number | null; maxChildren: number | null },
  request: { adults: number; childrenCount: number }
): boolean {
  if (accommodationType.maxAdults !== null && request.adults > accommodationType.maxAdults) return false;
  if (accommodationType.maxChildren !== null && request.childrenCount > accommodationType.maxChildren) return false;
  if (accommodationType.maxGuests !== null && request.adults + request.childrenCount > accommodationType.maxGuests) return false;
  return true;
}

function hasAnyKnownCapacity(candidate: AccommodationCandidate): boolean {
  return candidate.maxGuests !== null || candidate.maxAdults !== null || candidate.maxChildren !== null;
}

/** Best-effort "how big is this accommodation" for proximity sorting only — isCapacityCompatible (the hard constraint) never uses this. */
function approximateCapacity(candidate: AccommodationCandidate): number {
  if (candidate.maxGuests !== null) return candidate.maxGuests;
  return (candidate.maxAdults ?? 0) + (candidate.maxChildren ?? 0);
}

/**
 * Deterministic capacity filter + ranking — runs BEFORE the model ever sees
 * a candidate list, so the model cannot "choose" its way around a capacity
 * mismatch: an accommodation excluded here can never be reintroduced
 * downstream (the model is only ever shown the output of this function,
 * never the full unfiltered list — see answer.ts).
 *
 * Two request shapes are supported, in priority order:
 * - `party.adults` AND `party.children` both known -> full per-field check
 *   via isCapacityCompatible (adults/children/total all evaluated
 *   independently, per the business rule above).
 * - only `party.total` known (e.g. "nous sommes 3 personnes" — no
 *   adults/children breakdown) -> coarser fallback, maxGuests-only, exactly
 *   mirroring the original single-message behavior. Never attempts to
 *   guess a breakdown (e.g. "assume all adults") that isn't actually known.
 * - nothing known -> no exclusion at all; every active candidate comes
 *   back "unknown" fit, since no confident proximity ranking is possible
 *   either.
 *
 * Within compatible candidates, proximity ranking (closest capacity first)
 * always runs after exclusion, never instead of it.
 */
export function filterAndRankAccommodations(candidates: AccommodationCandidate[], party: PartySize): RankedCandidate[] {
  const known: RankedCandidate[] = [];
  const unknown: RankedCandidate[] = [];

  if (party.adults !== null && party.children !== null) {
    const request = { adults: party.adults, childrenCount: party.children };
    for (const candidate of candidates) {
      if (!isCapacityCompatible(candidate, request)) continue; // excluded — never reintroduced
      (hasAnyKnownCapacity(candidate) ? known : unknown).push({ ...candidate, fit: hasAnyKnownCapacity(candidate) ? "known" : "unknown" });
    }
    known.sort((a, b) => approximateCapacity(a) - approximateCapacity(b));
    return [...known, ...unknown];
  }

  if (party.total !== null) {
    const total = party.total;
    for (const candidate of candidates) {
      if (candidate.maxGuests === null) {
        unknown.push({ ...candidate, fit: "unknown" });
        continue;
      }
      if (candidate.maxGuests < total) continue; // excluded — never reintroduced
      known.push({ ...candidate, fit: "known" });
    }
    // Non-null asserted: every entry in `known` was pushed above only after confirming maxGuests !== null.
    known.sort((a, b) => a.maxGuests! - b.maxGuests!);
    return [...known, ...unknown];
  }

  return candidates.map((candidate) => ({ ...candidate, fit: "unknown" as const }));
}

// isPartyKnown moved to partySize.ts (it's a pure PartySize-domain concept,
// used by more than just accommodation ranking now — see
// extractPartySizeFromHistory there) — re-exported here so every existing
// import site (prompt.ts, tests) keeps working unchanged.
export { isPartyKnown } from "./partySize";
import { isPartyKnown as isPartyKnownInternal } from "./partySize";

/**
 * Single source of truth for "should this turn ask for the group size
 * before presenting anything, instead of showing the catalogue" — used by
 * BOTH buildHotelInstructions (prompt.ts, the model's own instruction) AND
 * answerQuestion (answer.ts, the deterministic roomCatalogue field it
 * computes independently — see that field's own doc comment in types.ts),
 * so the two can never drift out of sync with each other. Previously
 * computed inline, separately, only in prompt.ts.
 */
export function shouldAskPartySizeOnly(roomDiscoveryIntentDetected: boolean, mentionsPreciseAccommodation: boolean, party: PartySize): boolean {
  return roomDiscoveryIntentDetected && !mentionsPreciseAccommodation && !isPartyKnownInternal(party);
}

/**
 * Discovery-VERB + GENERIC room-type-NOUN, required together — deliberately
 * narrower than every other intent detector in this codebase (isPartnerIntent,
 * isSpaBookingIntent, isBookingIntent), which all err wide because a false
 * positive there is invisible/harmless. Here a false positive has a visible
 * side effect: it makes the assistant interrupt with "combien de personnes
 * ?" — so a bare mention of "chambre/suite/hébergement/appartement" alone
 * (e.g. "Suite Deluxe a la climatisation ?", a purely documentary question)
 * must never be enough on its own.
 *
 * "GENERIC" is the load-bearing word (stress test finding): a named,
 * already-precise category ("la Junior Suite", "la Mini-suite") must never
 * be treated the same as a catalogue-level request ("les chambres", "une
 * chambre") just because it happens to contain the same root word. The
 * distinguishing, hotel-agnostic signal (never a hardcoded category name)
 * is structural: in every real example seen, a generic mention has the
 * determiner/quantifier sitting DIRECTLY next to the noun ("les chambres",
 * "une chambre", "quelles chambres"), while a named category always inserts
 * at least one extra qualifying word — or a hyphen — between them ("la
 * JUNIOR suite", "la MINI-suite"). GENERIC_ROOM_MENTION_PATTERNS encodes
 * exactly that adjacency, nothing else. When real accommodation_types data
 * exists for a hotel, answer.ts additionally checks the message against the
 * hotel's own real category names (see mentionsKnownAccommodationName) —
 * this generic pattern is the fallback for when it doesn't (Le 1837 today).
 */
const DISCOVERY_VERB_PATTERNS: RegExp[] = [
  /\bmontre[rz]?(-moi)?\b/i,
  /\bvoir\b/i,
  /\bd[ée]couvrir\b/i,
  /\bcherch(?:e|es|ons|ez|er)\b/i,
  /\brecherch(?:e|es|ons|ez|er)\b/i,
  /\bproposez[- ]vous\b/i,
  /\bavez[- ]vous\b/i,
  /\bvous\s+avez\b/i,
];

/**
 * Optimal string alignment distance (Levenshtein plus one adjacent-
 * transposition operation, e.g. "hc" <-> "ch") — small, local, no
 * dependency. Only ever called on single short words (verb forms, a
 * handful of letters), so the plain O(n*m) DP table is more than fast
 * enough; never used on arbitrary-length text.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[m][n];
}

/**
 * Typo tolerance for the discovery verbs above — a real, confirmed gap: "je
 * charche une chambre" (a plain single-letter typo of "cherche") never
 * matched /\bcherch(?:e|es|ons|ez|er)\b/i at all, so ROOM_DISCOVERY never
 * activated even though the model itself understood the request perfectly
 * well in its own prose. Deliberately narrow:
 *
 * - Compared word-by-word against a short list of REAL inflected forms
 *   (the exact same alternations already spelled out in
 *   DISCOVERY_VERB_PATTERNS above, never a new invented stem system), at
 *   edit distance <= 1 (one substitution, insertion, deletion, or adjacent
 *   transposition) — never a substring/fuzzy scan of the whole message,
 *   which would risk matching a near-miss word that merely sits next to an
 *   unrelated one.
 * - "voir" is deliberately EXCLUDED — it is short and common enough
 *   (4 letters) that several real, unrelated French words sit at edit
 *   distance 1 from it ("noir", "soir", "voie"...); fuzzy-matching it would
 *   trade a rare typo for a real false-positive risk. It keeps its exact,
 *   deterministic match in DISCOVERY_VERB_PATTERNS above, unchanged.
 * - "avez-vous"/"proposez-vous"/"vous avez" are also excluded — two-word
 *   idioms are harder to fuzzy-match safely and are far less prone to a
 *   single-word typo than a single verb form; out of scope for this fix.
 *
 * This is purely ADDITIVE to DISCOVERY_VERB_PATTERNS (see isRoomDiscoveryIntent
 * below) — every existing exact match keeps matching exactly as before.
 */
const FUZZY_DISCOVERY_VERB_FORMS: string[] = [
  "cherche",
  "cherches",
  "cherchons",
  "cherchez",
  "chercher",
  "recherche",
  "recherches",
  "recherchons",
  "recherchez",
  "rechercher",
  "montre",
  "montrer",
  "montrez",
  "decouvrir",
  "découvrir",
];

function hasApproximateDiscoveryVerb(message: string): boolean {
  const words = message.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((word) =>
    FUZZY_DISCOVERY_VERB_FORMS.some((form) => Math.abs(word.length - form.length) <= 1 && editDistance(word, form) <= 1)
  );
}

const QUEL_ROOM_TYPE_PATTERN =
  /\bquel(?:le)?s?\s+(?:types?\s+d[e'’]\s*)?(chambres?|suites?|h[ée]bergements?|appartements?|logements?)\b/i;

/** Determiner/quantifier DIRECTLY touching the noun — see the doc comment above for why this is what "generic" means here. */
const GENERIC_DETERMINER_ROOM_MENTION_PATTERN =
  /\b(?:les?|la|des|une?|vos|nos|ces?|comme)\s+(chambres?|suites?|h[ée]bergements?|appartements?|logements?)\b/i;

function hasGenericRoomMention(message: string): boolean {
  return QUEL_ROOM_TYPE_PATTERN.test(message) || GENERIC_DETERMINER_ROOM_MENTION_PATTERN.test(message);
}

/**
 * A short, standalone catalogue mention with no verb at all ("les chambres
 * ?", "les suites ?") — a real, common, minimal way to ask "what rooms do
 * you have". Deliberately anchored to the WHOLE message (only optional
 * surrounding punctuation tolerated), never a substring match: this is what
 * keeps it from also swallowing a longer, documentary sentence that merely
 * mentions a room in passing ("la Junior Suite fait combien de mètres
 * carrés ?" is nowhere close to this shape).
 */
const ELLIPTICAL_CATALOGUE_PATTERN =
  /^\s*(?:les?|la|des|une?|vos|nos|ces?|quel(?:le)?s?)\s+(chambres?|suites?|h[ée]bergements?|appartements?|logements?)\s*[?!.]*\s*$/i;

export function isRoomDiscoveryIntent(message: string): boolean {
  if (QUEL_ROOM_TYPE_PATTERN.test(message)) return true;
  if (ELLIPTICAL_CATALOGUE_PATTERN.test(message)) return true;
  if (!hasGenericRoomMention(message)) return false;
  return DISCOVERY_VERB_PATTERNS.some((pattern) => pattern.test(message)) || hasApproximateDiscoveryVerb(message);
}

/**
 * When a hotel HAS real accommodation_types data, this is the authoritative
 * way to recognize a precise category mention — real names beat the
 * structural GENERIC_DETERMINER_ROOM_MENTION_PATTERN heuristic above, which
 * only exists as a fallback for when no such data exists yet (Le 1837
 * today, see answer.ts's own call site). Whole-name, word-boundary-safe,
 * case-insensitive match — never a fuzzy/partial one, and never a hardcoded
 * name for any specific hotel.
 */
function accommodationNameMatchesMessage(name: string, message: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const escaped = trimmed.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(message.toLowerCase());
}

export function mentionsKnownAccommodationName(message: string, accommodationNames: string[]): boolean {
  return accommodationNames.some((name) => accommodationNameMatchesMessage(name, message));
}

export interface AccommodationNameLookup {
  id: string;
  name: string;
  sourceUrl: string | null;
}

/**
 * Same matching rule as mentionsKnownAccommodationName above (reused, not
 * duplicated — accommodationNameMatchesMessage is the single source of
 * truth for "does this real name appear in this message") — but returns
 * WHICH accommodation matched, needed to resolve its source_url for scoped
 * retrieval (see retrieve.ts:fetchAccommodationSourceChunks and answer.ts's
 * own call site).
 *
 * Collision handling: when several real names match the same message (e.g.
 * "Deluxe" is a substring-word of "Deluxe PMR" — "la Deluxe PMR a la clim ?"
 * matches BOTH), the MOST SPECIFIC one wins — simply the longest matching
 * name. A generic, hotel-agnostic tie-break: never a hardcoded pair like
 * "Deluxe"/"Deluxe PMR", works for any hotel's own category names.
 */
export function findMentionedAccommodation<T extends AccommodationNameLookup>(message: string, accommodations: T[]): T | null {
  const matches = accommodations.filter((a) => accommodationNameMatchesMessage(a.name, message));
  if (matches.length === 0) return null;
  return matches.reduce((best, current) => (current.name.length > best.name.length ? current : best));
}
