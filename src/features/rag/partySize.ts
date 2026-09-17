/**
 * Deterministic, best-effort extraction of a visitor's group size from their
 * message — no LLM call. Exists so the server can build a hard capacity
 * filter (see accommodationRanking.ts) BEFORE the model ever sees a list of
 * accommodations, instead of asking the model to both understand the group
 * size AND respect a capacity constraint in one uncontrolled step.
 *
 * Deliberately narrow: only catches fairly explicit phrasings ("2 adultes et
 * 1 enfant", "3 personnes", "family of 4"). An implicit or ambiguous group
 * size yields `total: null` — never a guess. Callers must treat `null` as
 * "not enough information to filter by capacity", not as "zero people".
 */
export interface PartySize {
  adults: number | null;
  children: number | null;
  total: number | null;
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseCount(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  return NUMBER_WORDS[trimmed] ?? null;
}

const NUM = "(\\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|one|two|three|four|five|six|seven|eight|nine|ten)";

const ADULT_PATTERN = new RegExp(`${NUM}\\s*(adultes?|adults?)`, "i");
const CHILD_PATTERN = new RegExp(`${NUM}\\s*(enfants?|child(?:ren)?|kids?)`, "i");
const TOTAL_PEOPLE_PATTERN = new RegExp(`${NUM}\\s*(personnes?|pers\\.?|guests?|people)\\b`, "i");
const FAMILY_OF_PATTERN = new RegExp(`(?:famille de|family of)\\s*${NUM}`, "i");
/** "on est 4" is the extremely common colloquial register of "nous sommes 4" — same meaning, just less formal. */
const NOUS_SOMMES_PATTERN = new RegExp(`(?:nous sommes|on est|we are)\\s*${NUM}\\b`, "i");
/**
 * Bare "pour 2" (no accompanying "personnes"/"adultes"/etc.) — a real,
 * common ellipsis in a hotel chat ("montre moi ce que vous avez pour 2").
 * Lowest priority on purpose (checked only when nothing more explicit
 * matched) and guarded by a negative lookahead: "pour 2 nuits"/"pour 2
 * euros" must never be misread as a party size.
 */
const POUR_N_PATTERN = new RegExp(`\\bpour\\s+${NUM}\\b(?!\\s*(?:nuits?|nights?|jours?|days?|€|euros?|\\$|dollars?))`, "i");

/**
 * Extracts {adults, children, total} from one message. `total` is derived
 * from adults+children when both are found; otherwise from an explicit
 * total-people phrasing ("3 personnes", "we are 3", "family of 4", "on est
 * 4", or a bare "pour 2"). Any field that can't be confidently parsed stays
 * null.
 */
export function extractPartySize(message: string): PartySize {
  const adultMatch = message.match(ADULT_PATTERN);
  const childMatch = message.match(CHILD_PATTERN);

  const adults = adultMatch ? parseCount(adultMatch[1]) : null;
  const children = childMatch ? parseCount(childMatch[1]) : null;

  if (adults !== null || children !== null) {
    const total = (adults ?? 0) + (children ?? 0);
    return { adults, children, total: total > 0 ? total : null };
  }

  const totalMatch =
    message.match(TOTAL_PEOPLE_PATTERN) ??
    message.match(FAMILY_OF_PATTERN) ??
    message.match(NOUS_SOMMES_PATTERN) ??
    message.match(POUR_N_PATTERN);
  if (totalMatch) {
    const total = parseCount(totalMatch[1]);
    if (total !== null) return { adults: null, children: null, total };
  }

  return { adults: null, children: null, total: null };
}

/**
 * Merges a validated multi-turn stay-request extraction (see
 * availability/extractStayRequest.ts + stayRequest.ts) into the current
 * party — extracted out of answer.ts so this rule is a real, directly
 * testable pure function rather than an inline block only checkable by
 * reading source text.
 *
 * The middle case is the fix for a real, confirmed bug: "nous sommes 2"
 * resolves to {adults: 2, childrenCount: null} — the extractor correctly
 * leaves childrenCount at null rather than fabricating "0 enfant" (null
 * means "unknown", 0 means "explicitly none" — see
 * extractStayRequest.ts's own extraction instructions). Requiring BOTH
 * halves before accepting ANY update silently discarded this — a real,
 * common, adults-only phrasing — every time. This never claims a false "0
 * enfant": when only one half is known, the granular {adults, children}
 * breakdown is left null and only the honest, coarser `total` is kept —
 * exactly the same degraded mode filterAndRankAccommodations already
 * supports for a bare "3 personnes" single-message match (see
 * accommodationRanking.ts), not a new concept.
 */
export function mergeValidatedStayRequestIntoParty(
  current: PartySize,
  validated: { adults: number | null; childrenCount: number | null }
): PartySize {
  if (validated.adults !== null && validated.childrenCount !== null) {
    return { adults: validated.adults, children: validated.childrenCount, total: validated.adults + validated.childrenCount };
  }
  if (validated.adults !== null || validated.childrenCount !== null) {
    return { adults: null, children: null, total: (validated.adults ?? 0) + (validated.childrenCount ?? 0) };
  }
  return current;
}

/**
 * "Known" for gating purposes — a full adults+children breakdown, or a bare
 * total (e.g. from a single-message "3 personnes" match, or from
 * extractPartySizeFromHistory below). Moved here from accommodationRanking.ts
 * (still re-exported there) since it's a pure PartySize-domain concept, used
 * by more than accommodation ranking now.
 */
export function isPartyKnown(party: PartySize): boolean {
  return party.total !== null || (party.adults !== null && party.children !== null);
}

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Deterministic, LLM-free multi-turn fallback — tried BEFORE
 * resolveStayRequestFromHistory's OpenAI call (see answer.ts), not instead
 * of it: that call is still needed for dates/rooms, which this never
 * touches. Scans the visitor's OWN past messages, most recent first, for an
 * explicit party-size statement extractPartySize can already parse alone
 * (e.g. "nous sommes 2" said one turn ago, when the CURRENT message —
 * "montre moi les chambres" — no longer repeats it).
 *
 * This exists because a real, measured problem: for exactly this simple,
 * unambiguous case, resolveStayRequestFromHistory's own OpenAI call only
 * resolved it correctly in about half of repeated real calls (see this
 * chantier's stress test) — genuine model non-determinism on a case that a
 * plain regex already handles perfectly and instantly. Reaching for the LLM
 * FIRST for information the deterministic extractor already owns was the
 * actual bug; this makes the deterministic path authoritative when it has
 * an answer, and defers to the LLM only for what it alone can do (dates).
 *
 * Recency-first: a later, corrected party size ("en fait nous sommes 4")
 * must win over an earlier one. Only ever inspects `role: "user"` messages —
 * a value the ASSISTANT merely proposed is never treated as a fact about the
 * visitor's own party (same discipline as extractStayRequest.ts's own
 * extraction instructions for the LLM path).
 */
export function extractPartySizeFromHistory(history: HistoryMessage[]): PartySize | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const candidate = extractPartySize(history[i].content);
    if (isPartyKnown(candidate)) return candidate;
  }
  return null;
}
