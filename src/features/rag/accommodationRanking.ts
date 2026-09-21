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
 * before presenting anything, instead of recommending" — used by BOTH
 * buildHotelInstructions (prompt.ts, the model's own instruction) AND
 * answerQuestion (answer.ts, the deterministic roomCatalogue field it
 * computes independently — see that field's own doc comment in types.ts),
 * so the two can never drift out of sync with each other. Previously
 * computed inline, separately, only in prompt.ts.
 *
 * 3-INTENTIONS chantier: the first parameter used to be the old, single
 * roomDiscoveryIntentDetected flag (which conflated INFORMATION, CATALOGUE
 * AND RECOMMENDATION into one signal — see isRoomDiscoveryIntent's own doc
 * comment for why that was wrong). It is now recommendationIntentDetected
 * (isAccommodationRecommendationIntent below, or its own continuation
 * marker) — the party question must fire ONLY for a genuine "what do you
 * recommend for us" request, never for a plain informational or
 * catalogue/browsing turn, both of which must never ask for capacity at
 * all. The function body itself is unchanged: only the caller's signal
 * changed meaning.
 */
export function shouldAskPartySizeOnly(recommendationIntentDetected: boolean, mentionsPreciseAccommodation: boolean, party: PartySize): boolean {
  return recommendationIntentDetected && !mentionsPreciseAccommodation && !isPartyKnownInternal(party);
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

/** Determiner/quantifier DIRECTLY touching the noun — see the doc comment above for why this is what "generic" means here. */
const GENERIC_DETERMINER_ROOM_MENTION_PATTERN =
  /\b(?:les?|la|des|une?|vos|nos|ces?|comme)\s+(chambres?|suites?|h[ée]bergements?|appartements?|logements?)\b/i;

/**
 * 3-INTENTIONS chantier: no longer includes the old "quel(s) type(s) de
 * NOUN" shape (moved to ACCOMMODATION_INFORMATION_TYPES_PATTERN below) —
 * that shape is a WH-question about which categories exist ("what KINDS of
 * rooms do you have"), never a request to browse/see them, so it must never
 * feed the CATALOGUE-flavored detector below. Only the determiner+noun
 * shape ("les chambres", "vos logements", "comme hébergements") remains
 * here — always paired with a display verb (montre/voir/...) by
 * isRoomDiscoveryIntent itself, never used alone.
 */
function hasGenericRoomMention(message: string): boolean {
  return GENERIC_DETERMINER_ROOM_MENTION_PATTERN.test(message);
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

/**
 * 3-INTENTIONS chantier (audit "AUDIT INTENTIONS HÉBERGEMENTS"): this used
 * to also match the bare "quel(s) [type(s) de] NOUN" WH-shape, which is why
 * a pure informational question ("Quels types de chambres proposez-vous ?")
 * was wrongly treated exactly like "Montrez-moi vos logements." — both
 * ended up asking for the group size before answering anything. That shape
 * is now ACCOMMODATION_INFORMATION_TYPES_PATTERN's job (see
 * isAccommodationInformationIntent below): a WH-question about which
 * categories exist is answered in prose from structured data, never gated
 * on capacity. isRoomDiscoveryIntent is now exclusively the CATALOGUE/
 * browsing signal — "show me / let me see" (a display verb) or the bare
 * elliptical "les chambres ?" — never a bare category-naming question.
 */
export function isRoomDiscoveryIntent(message: string): boolean {
  if (ELLIPTICAL_CATALOGUE_PATTERN.test(message)) return true;
  if (!hasGenericRoomMention(message)) return false;
  return DISCOVERY_VERB_PATTERNS.some((pattern) => pattern.test(message)) || hasApproximateDiscoveryVerb(message);
}

/**
 * INFORMATION — "what KINDS/TYPES of X do you have", a WH-question about
 * which categories exist, never a request to see them (isRoomDiscoveryIntent
 * above, CATALOGUE) nor a request for personal advice
 * (isAccommodationRecommendationIntent below, RECOMMENDATION). Widened from
 * the original "quel(s) [type(s) de] NOUN" shape to also cover "quels SONT
 * vos types d'appartements" (a real, reported phrasing whose extra "sont
 * vos" broke the original pattern's strict word-by-word adjacency).
 */
const ACCOMMODATION_INFORMATION_TYPES_PATTERN =
  /\bquel(?:le)?s?\s+(?:sont\s+)?(?:vos|ses|leurs|nos|les)?\s*(?:types?\s+d[e'’]\s*)?(chambres?|suites?|h[ée]bergements?|appartements?|logements?)\b/i;

/** "vous proposez quoi comme X" / "quoi comme X" — same informational shape, reversed word order from the discovery-verb idioms in DISCOVERY_VERB_PATTERNS. */
const ACCOMMODATION_INFORMATION_QUOI_COMME_PATTERN =
  /\bquoi\s+comme\s+(chambres?|suites?|h[ée]bergements?|appartements?|logements?)\b/i;

export function isAccommodationInformationIntent(message: string): boolean {
  return ACCOMMODATION_INFORMATION_TYPES_PATTERN.test(message) || ACCOMMODATION_INFORMATION_QUOI_COMME_PATTERN.test(message);
}

/**
 * RECOMMENDATION — a genuine "what do you advise for US" request, deliberately
 * requiring an explicit recommendation-flavored VERB (conseiller/recommander/
 * "le mieux"/convenir), never inferred from a bare room-noun mention alone
 * (a plain "quel logement proposez-vous" is INFORMATION/CATALOGUE, not a
 * request for personal advice) — mirrors isRoomDiscoveryIntent's own
 * verb+noun pairing discipline, so "je vous conseille de venir tôt" (no
 * accommodation noun at all) never triggers the capacity question.
 */
const RECOMMENDATION_VERB_PATTERNS: RegExp[] = [
  /\bconseill(?:e|es|ez|ons|er|erais|eriez|erait)\b/i,
  /\brecommand(?:e|es|ez|ons|er|erais|eriez|erait)\b/i,
  /\ble mieux\b/i,
  /\bconvien(?:t|nent|drait|drais)\b/i,
  /\bconvenir\b/i,
];

export function isAccommodationRecommendationIntent(message: string): boolean {
  if (!RECOMMENDATION_VERB_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return (
    hasGenericRoomMention(message) ||
    ACCOMMODATION_INFORMATION_TYPES_PATTERN.test(message) ||
    ELLIPTICAL_CATALOGUE_PATTERN.test(message)
  );
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
 * own call site) AND as the deterministic authority for roomRecommendation
 * (see answer.ts:resolveAuthoritativeAccommodationId).
 *
 * Two different multi-match shapes have to be told apart here — collapsing
 * them into one rule is the exact bug this function used to have (a real,
 * confirmed "Deluxe ou Superior pour 4 personnes ?" mix-up: the model's own
 * text and recommendedAccommodationTypeId agreed on Deluxe, but this
 * function unconditionally returned Superior — the longer of the two names
 * — which then silently overrode the model's already-coherent choice via
 * resolveAuthoritativeAccommodationId):
 *
 * - SPECIFICITY COLLISION: one matched name is textually a superstring of
 *   every other matched name (e.g. "Deluxe" is a substring-word of "Deluxe
 *   PMR" — "la Deluxe PMR a la clim ?" matches BOTH). These aren't two
 *   independent mentions, they're one physical mention read at two
 *   granularities — the MOST SPECIFIC one (the superstring) still wins, so
 *   the historical Deluxe/Deluxe PMR fix stays exactly as it was.
 * - INDEPENDENT MENTIONS: two or more matched names where at least one is
 *   NOT contained in the longest match (e.g. "Deluxe" and "Superior" —
 *   neither is a substring of the other) — a genuine comparison between
 *   distinct categories, not a specificity collision. No name-based
 *   heuristic can pick the "right" one here (name length has no relationship
 *   to which the user or the model actually prefers), so this returns null
 *   — ambiguous, deliberately — letting resolveAuthoritativeAccommodationId
 *   fall through to the model's own recommendedAccommodationTypeId instead,
 *   which is already validated against rankedCandidates and, unlike this
 *   purely textual match, is free to reason about capacity, amenities and
 *   the actual question asked.
 *
 * Generic and hotel-agnostic either way: never a hardcoded pair like
 * "Deluxe"/"Deluxe PMR", works for any hotel's own category names.
 */
export function findMentionedAccommodation<T extends AccommodationNameLookup>(message: string, accommodations: T[]): T | null {
  const matches = accommodations.filter((a) => accommodationNameMatchesMessage(a.name, message));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  const longest = matches.reduce((best, current) => (current.name.length > best.name.length ? current : best));
  const longestLower = longest.name.trim().toLowerCase();
  const isSpecificityCollision = matches.every((m) => longestLower.includes(m.name.trim().toLowerCase()));
  return isSpecificityCollision ? longest : null;
}
