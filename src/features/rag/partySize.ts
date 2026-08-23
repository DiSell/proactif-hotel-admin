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
const NOUS_SOMMES_PATTERN = new RegExp(`(?:nous sommes|we are)\\s*${NUM}\\b`, "i");

/**
 * Extracts {adults, children, total} from one message. `total` is derived
 * from adults+children when both are found; otherwise from an explicit
 * total-people phrasing ("3 personnes", "we are 3", "family of 4"). Any
 * field that can't be confidently parsed stays null.
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
    message.match(TOTAL_PEOPLE_PATTERN) ?? message.match(FAMILY_OF_PATTERN) ?? message.match(NOUS_SOMMES_PATTERN);
  if (totalMatch) {
    const total = parseCount(totalMatch[1]);
    if (total !== null) return { adults: null, children: null, total };
  }

  return { adults: null, children: null, total: null };
}
