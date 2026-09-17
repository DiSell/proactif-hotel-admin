import { describe, expect, it } from "vitest";
import { extractPartySize, extractPartySizeFromHistory, isPartyKnown, mergeValidatedStayRequestIntoParty } from "./partySize";

describe("extractPartySize", () => {
  it("extracts adults and children from an explicit French phrasing", () => {
    expect(extractPartySize("Nous sommes 2 adultes avec un enfant.")).toEqual({ adults: 2, children: 1, total: 3 });
  });

  it("extracts adults and children from an explicit English phrasing", () => {
    expect(extractPartySize("We are 2 adults and 1 child.")).toEqual({ adults: 2, children: 1, total: 3 });
  });

  it("extracts adults only when no children are mentioned", () => {
    expect(extractPartySize("2 adultes, quelle chambre nous conseillez-vous ?")).toEqual({ adults: 2, children: null, total: 2 });
  });

  it("extracts a plain total-people phrasing (French)", () => {
    expect(extractPartySize("Nous sommes 3 personnes.")).toEqual({ adults: null, children: null, total: 3 });
  });

  it("extracts a plain total-people phrasing (English)", () => {
    expect(extractPartySize("There will be 4 guests.")).toEqual({ adults: null, children: null, total: 4 });
  });

  it("extracts a 'family of N' phrasing", () => {
    expect(extractPartySize("We are a family of 4 looking for a room.")).toEqual({ adults: null, children: null, total: 4 });
  });

  it("understands number words, not just digits", () => {
    expect(extractPartySize("Nous sommes deux adultes et trois enfants.")).toEqual({ adults: 2, children: 3, total: 5 });
  });

  it("[ambiguous] returns all-null when the group size can't be confidently parsed", () => {
    expect(extractPartySize("Quelle est la meilleure chambre pour nous ?")).toEqual({ adults: null, children: null, total: null });
  });

  it("[ambiguous] a bare number with no people-related keyword is not treated as a party size", () => {
    expect(extractPartySize("Nous arrivons le 3 juillet.")).toEqual({ adults: null, children: null, total: null });
  });

  it("[colloquial] 'on est N' is the informal register of 'nous sommes N' — same result", () => {
    expect(extractPartySize("on est 4 tu as quoi ?")).toEqual({ adults: null, children: null, total: 4 });
  });

  it("[bare 'pour N'] a real, common ellipsis in a hotel chat ('pour 2' = for 2 people)", () => {
    expect(extractPartySize("montre moi ce que vous avez pour 2")).toEqual({ adults: null, children: null, total: 2 });
  });

  it("[bare 'pour N', number word] 'pour deux' also resolves", () => {
    expect(extractPartySize("vous avez quoi pour deux ?")).toEqual({ adults: null, children: null, total: 2 });
  });

  it("[negative guard] 'pour N nuits' is never misread as a party size", () => {
    expect(extractPartySize("je réserve pour 2 nuits")).toEqual({ adults: null, children: null, total: null });
  });

  it("[negative guard] 'pour N euros' is never misread as a party size", () => {
    expect(extractPartySize("un forfait pour 2 euros")).toEqual({ adults: null, children: null, total: null });
  });

  it("['pour N personnes' still takes the more explicit TOTAL_PEOPLE_PATTERN, not the bare-'pour' fallback] — same result either way, but confirms priority order", () => {
    expect(extractPartySize("vous avez quoi pour 2 personnes ?")).toEqual({ adults: null, children: null, total: 2 });
  });
});

/**
 * Deterministic multi-turn fallback — the actual fix for the measured
 * resolveStayRequestFromHistory non-determinism (2/4 real calls resolved
 * "nous sommes 2" correctly, 2/4 didn't). Being a pure function, a single
 * deterministic test run here is the correct level of assurance: unlike the
 * LLM call, there is no flakiness left to catch by repeating it.
 */
describe("extractPartySizeFromHistory", () => {
  it("[the actual fix] recovers 'nous sommes 2' said one turn ago, when the CURRENT message repeats nothing", () => {
    const history = [
      { role: "user" as const, content: "nous sommes 2" },
      { role: "assistant" as const, content: "Très bien !" },
    ];
    expect(extractPartySizeFromHistory(history)).toEqual({ adults: null, children: null, total: 2 });
  });

  it("[colloquial] 'on est 4' said earlier is also recovered", () => {
    const history = [
      { role: "user" as const, content: "on est 4" },
      { role: "assistant" as const, content: "Parfait, je regarde ça." },
      { role: "user" as const, content: "montre moi les chambres" },
    ];
    expect(extractPartySizeFromHistory(history)).toEqual({ adults: null, children: null, total: 4 });
  });

  it("[recency wins] a later correction overrides an earlier statement", () => {
    const history = [
      { role: "user" as const, content: "nous sommes 2" },
      { role: "assistant" as const, content: "D'accord." },
      { role: "user" as const, content: "en fait on est 4" },
    ];
    expect(extractPartySizeFromHistory(history)).toEqual({ adults: null, children: null, total: 4 });
  });

  it("[assistant messages never count] a value the assistant merely proposed is never treated as the visitor's own party", () => {
    const history = [{ role: "assistant" as const, content: "Vous êtes 2 personnes, c'est bien ça ?" }];
    expect(extractPartySizeFromHistory(history)).toBeNull();
  });

  it("[nothing to find] returns null, never a guess", () => {
    const history = [
      { role: "user" as const, content: "Est-ce que la Suite Deluxe a la climatisation ?" },
      { role: "assistant" as const, content: "Oui, elle dispose de la climatisation réversible." },
    ];
    expect(extractPartySizeFromHistory(history)).toBeNull();
  });

  it("[empty history] returns null", () => {
    expect(extractPartySizeFromHistory([])).toBeNull();
  });

  it("[no perturbation — dates] a date-only message in history is never mistaken for a party size", () => {
    const history = [{ role: "user" as const, content: "je veux arriver le 20 septembre" }];
    expect(extractPartySizeFromHistory(history)).toBeNull();
  });

  it("[no perturbation — nights] a nights-count message in history is never mistaken for a party size", () => {
    const history = [{ role: "user" as const, content: "je réserve pour 3 nuits" }];
    expect(extractPartySizeFromHistory(history)).toBeNull();
  });

  it("[no perturbation — prices] a price message in history is never mistaken for a party size", () => {
    const history = [{ role: "user" as const, content: "combien coûte la chambre pour 2 nuits ?" }];
    expect(extractPartySizeFromHistory(history)).toBeNull();
  });

  it("[no perturbation — room numbers] a room-number-shaped message is never mistaken for a party size", () => {
    const history = [{ role: "user" as const, content: "je suis dans la chambre 12" }];
    expect(extractPartySizeFromHistory(history)).toBeNull();
  });
});

describe("isPartyKnown (moved here from accommodationRanking.ts, still re-exported there)", () => {
  it("known via total", () => {
    expect(isPartyKnown({ adults: null, children: null, total: 2 })).toBe(true);
  });

  it("unknown — nothing determined", () => {
    expect(isPartyKnown({ adults: null, children: null, total: null })).toBe(false);
  });
});

/**
 * Real bug fix (stress test, requirement 2): "nous sommes 2" resolves via
 * resolveStayRequestFromHistory to {adults: 2, childrenCount: null} — never
 * to {adults: 2, childrenCount: 0}, since the extractor explicitly
 * distinguishes "unknown" (null) from "explicitly none" (0). Requiring BOTH
 * halves before accepting ANY update silently discarded this real,
 * common, adults-only phrasing every time.
 */
describe("mergeValidatedStayRequestIntoParty", () => {
  const fallback = { adults: null, children: null, total: null };

  it("[full breakdown known] both halves resolved -> granular party, same as before", () => {
    expect(mergeValidatedStayRequestIntoParty(fallback, { adults: 2, childrenCount: 1 })).toEqual({ adults: 2, children: 1, total: 3 });
  });

  it("[the fix] adults known, children genuinely unknown (null, not 0) -> total-only party, never a fabricated '0 enfant'", () => {
    const result = mergeValidatedStayRequestIntoParty(fallback, { adults: 2, childrenCount: null });
    expect(result).toEqual({ adults: null, children: null, total: 2 });
    expect(result.children).not.toBe(0); // never asserts "no children" when it's actually unknown
  });

  it("[symmetric] children known, adults genuinely unknown -> total-only party", () => {
    expect(mergeValidatedStayRequestIntoParty(fallback, { adults: null, childrenCount: 1 })).toEqual({ adults: null, children: null, total: 1 });
  });

  it("[explicitly 0 children] still accepted as a real, known value — 0 is not null", () => {
    expect(mergeValidatedStayRequestIntoParty(fallback, { adults: 2, childrenCount: 0 })).toEqual({ adults: 2, children: 0, total: 2 });
  });

  it("[nothing resolved] falls back to whatever party already was — never overwritten with an unknown state", () => {
    const existing = { adults: null, children: null, total: 4 };
    expect(mergeValidatedStayRequestIntoParty(existing, { adults: null, childrenCount: null })).toBe(existing);
  });
});
