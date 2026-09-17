import { describe, expect, it } from "vitest";
import {
  filterAndRankAccommodations,
  findMentionedAccommodation,
  isCapacityCompatible,
  isPartyKnown,
  isRoomDiscoveryIntent,
  mentionsKnownAccommodationName,
  type AccommodationCandidate,
  type AccommodationNameLookup,
} from "./accommodationRanking";
import type { PartySize } from "./partySize";

function candidate(id: string, name: string, maxGuests: number | null, maxAdults: number | null = null, maxChildren: number | null = null): AccommodationCandidate {
  return { id, name, maxGuests, maxAdults, maxChildren };
}

function party(total: number | null): PartySize {
  return { adults: null, children: null, total };
}

function partyOf(adults: number | null, children: number | null): PartySize {
  return { adults, children, total: adults !== null && children !== null ? adults + children : null };
}

describe("filterAndRankAccommodations", () => {
  it("[scenario 1] A(3) B(4) C(6), party=3 — C is never ranked before A or B", () => {
    const candidates = [candidate("a", "A", 3), candidate("b", "B", 4), candidate("c", "C", 6)];
    const result = filterAndRankAccommodations(candidates, party(3));
    const ids = result.map((r) => r.id);
    expect(ids.indexOf("c")).toBeGreaterThan(ids.indexOf("a"));
    expect(ids.indexOf("c")).toBeGreaterThan(ids.indexOf("b"));
    expect(ids).toEqual(["a", "b", "c"]); // exact-fit first, then ascending distance
    expect(result.every((r) => r.fit === "known")).toBe(true);
  });

  it("[scenario 2] A(2) B(4) C(6), party=3 — A excluded, B ranked before C", () => {
    const candidates = [candidate("a", "A", 2), candidate("b", "B", 4), candidate("c", "C", 6)];
    const result = filterAndRankAccommodations(candidates, party(3));
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain("a"); // excluded, capacity 2 < party 3
    expect(ids).toEqual(["b", "c"]);
  });

  it("[unknown capacity] a candidate with no maxGuests is kept but marked unknown, and never ranked ahead of a known-compatible one", () => {
    const candidates = [candidate("known", "Known", 4), candidate("mystery", "Mystery", null)];
    const result = filterAndRankAccommodations(candidates, party(3));
    expect(result.map((r) => r.id)).toEqual(["known", "mystery"]);
    expect(result.find((r) => r.id === "known")?.fit).toBe("known");
    expect(result.find((r) => r.id === "mystery")?.fit).toBe("unknown");
  });

  it("[no reliable data] every candidate has unknown capacity -> all unknown fit, none excluded", () => {
    const candidates = [candidate("a", "A", null), candidate("b", "B", null)];
    const result = filterAndRankAccommodations(candidates, party(3));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.fit === "unknown")).toBe(true);
  });

  it("[party size unknown] no exclusion at all — every candidate returned as unknown fit", () => {
    const candidates = [candidate("a", "A", 2), candidate("b", "B", 6)];
    const result = filterAndRankAccommodations(candidates, party(null));
    expect(result.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(result.every((r) => r.fit === "unknown")).toBe(true);
  });

  it("an excluded candidate never reappears regardless of input order", () => {
    const candidates = [candidate("small", "Small", 1), candidate("big", "Big", 10)];
    const result = filterAndRankAccommodations(candidates, party(5));
    expect(result.map((r) => r.id)).toEqual(["big"]);
  });
});

describe("isCapacityCompatible", () => {
  it("excludes when adults exceeds maxAdults, even if maxGuests would allow it", () => {
    expect(isCapacityCompatible({ maxGuests: 10, maxAdults: 2, maxChildren: null }, { adults: 3, childrenCount: 0 })).toBe(false);
  });

  it("excludes when childrenCount exceeds maxChildren", () => {
    expect(isCapacityCompatible({ maxGuests: 10, maxAdults: null, maxChildren: 1 }, { adults: 2, childrenCount: 2 })).toBe(false);
  });

  it("excludes when the total exceeds maxGuests even if adults/children individually fit", () => {
    expect(isCapacityCompatible({ maxGuests: 3, maxAdults: 4, maxChildren: 4 }, { adults: 2, childrenCount: 2 })).toBe(false);
  });

  it("a null ceiling never excludes on that dimension", () => {
    expect(isCapacityCompatible({ maxGuests: null, maxAdults: null, maxChildren: null }, { adults: 10, childrenCount: 10 })).toBe(true);
  });

  it("compatible when every known ceiling is respected", () => {
    expect(isCapacityCompatible({ maxGuests: 4, maxAdults: 2, maxChildren: 2 }, { adults: 2, childrenCount: 2 })).toBe(true);
  });
});

describe("filterAndRankAccommodations — granular adults/childrenCount request", () => {
  it("excludes by maxAdults even when maxGuests alone would have allowed the candidate", () => {
    const candidates = [candidate("a", "A", 10, 2, null)];
    const result = filterAndRankAccommodations(candidates, partyOf(3, 0));
    expect(result).toHaveLength(0);
  });

  it("excludes by maxChildren independently of adults/total", () => {
    const candidates = [candidate("a", "A", 10, null, 1)];
    const result = filterAndRankAccommodations(candidates, partyOf(2, 2));
    expect(result).toHaveLength(0);
  });

  it("a candidate with no capacity fields at all is kept as unknown fit, never excluded", () => {
    const candidates = [candidate("a", "A", null, null, null)];
    const result = filterAndRankAccommodations(candidates, partyOf(2, 1));
    expect(result).toHaveLength(1);
    expect(result[0].fit).toBe("unknown");
  });

  it("compatible candidates are ranked by proximity of approximate capacity", () => {
    const candidates = [candidate("big", "Big", 8, 8, 8), candidate("close", "Close", 3, 3, 3)];
    const result = filterAndRankAccommodations(candidates, partyOf(2, 1));
    expect(result.map((r) => r.id)).toEqual(["close", "big"]);
  });
});

describe("isPartyKnown", () => {
  it("known via total", () => {
    expect(isPartyKnown(party(2))).toBe(true);
  });

  it("known via adults+children", () => {
    expect(isPartyKnown(partyOf(2, 0))).toBe(true);
  });

  it("unknown — nothing determined at all", () => {
    expect(isPartyKnown(party(null))).toBe(false);
  });

  it("unknown — only adults known, children still null", () => {
    expect(isPartyKnown({ adults: 2, children: null, total: null })).toBe(false);
  });
});

/**
 * ROOM_DISCOVERY intent — deliberately narrower than every other detector in
 * this codebase (isPartnerIntent/isSpaBookingIntent/isBookingIntent all err
 * wide): requires a discovery-verb + room-noun combination together, never a
 * bare room-word alone, so a purely documentary question about a named room
 * ("Suite Deluxe a la climatisation ?") never mis-fires and interrupts with
 * "combien de personnes ?".
 */
describe("isRoomDiscoveryIntent", () => {
  it.each([
    "montre-moi les chambres",
    "je peux voir les chambres ?",
    "quelles chambres avez-vous ?",
    "je voudrais découvrir les suites",
    "montrez-moi vos hébergements",
    "quels appartements proposez-vous ?",
    "tu peus me montrer les chambres ??",
    "montre-moi les chambres pour 2 personnes",
    // Stress-test round 2 — catalogue-level requests that must now pass too.
    "montre moi les chambres",
    "tu peux me montrer les chambres ?",
    "quelles chambres avez vous ?",
    "les chambres ?", // elliptical, no verb at all
    "je peux voir les appartements ?",
    "vous avez quoi comme chambre ?", // declarative "vous avez", not the inverted "avez-vous"
    "je cherche une chambre pour 2", // "chercher" was entirely absent from the verb list
    "fais moi voir les suites",
    "les suites ?", // elliptical
  ])("[positive] %s", (message) => {
    expect(isRoomDiscoveryIntent(message)).toBe(true);
  });

  it.each([
    "Suite Deluxe a la climatisation ?",
    "Est-ce que la Suite Deluxe a la climatisation ?",
    "Et pour 2 personnes ?",
    "quel est le prix de la chambre ?",
    "ok une chambre pour 2 ?",
    "avez-vous une piscine ?",
    // Stress-test round 2 — a NAMED, precise category must never be treated
    // as a generic catalogue request just because it contains a generic
    // root word ("suite" inside "Junior Suite").
    "je veux voir la junior suite",
    "montre moi la deluxe",
    "parle moi de la Mini-suite",
    "la Junior Suite fait combien de mètres carrés ?",
    "vous avez un parking ?",
    "combien coûte la Deluxe ?",
    "le spa est ouvert ?",
  ])("[negative] %s", (message) => {
    expect(isRoomDiscoveryIntent(message)).toBe(false);
  });
});

describe("mentionsKnownAccommodationName", () => {
  const names = ["Deluxe", "Junior Suite", "Mini-suite"];

  it("matches a real category name regardless of case", () => {
    expect(mentionsKnownAccommodationName("je veux voir la JUNIOR SUITE", names)).toBe(true);
    expect(mentionsKnownAccommodationName("montre moi la deluxe", names)).toBe(true);
  });

  it("never matches a name that isn't in the real list", () => {
    expect(mentionsKnownAccommodationName("je veux voir la Suite Royale", names)).toBe(false);
  });

  it("word-boundary safe — never a partial/fuzzy match", () => {
    expect(mentionsKnownAccommodationName("Deluxexxx", names)).toBe(false);
  });

  it("empty list never matches anything (e.g. a hotel with no accommodation_types yet)", () => {
    expect(mentionsKnownAccommodationName("je veux voir la Deluxe", [])).toBe(false);
  });
});

/**
 * Le 1837's real 7 categories — including the two genuine collision-prone
 * pairs (Deluxe/Deluxe PMR, Junior Suite/Junior PMR) — used across this
 * describe block instead of synthetic names, since the collision behavior
 * is exactly what needs proving against real, shipped data.
 */
function le1837Lookups(): AccommodationNameLookup[] {
  return [
    { id: "deluxe", name: "Deluxe", sourceUrl: "https://www.le1837.com/en/deluxe" },
    { id: "deluxe-pmr", name: "Deluxe PMR", sourceUrl: null },
    { id: "junior-suite", name: "Junior Suite", sourceUrl: "https://www.le1837.com/en/junior-suite" },
    { id: "junior-pmr", name: "Junior PMR", sourceUrl: "https://www.le1837.com/en/junior-pmr" },
    { id: "mini-suite", name: "Mini-suite", sourceUrl: "https://www.le1837.com/en/mini-suite" },
    { id: "standard", name: "Standard", sourceUrl: "https://www.le1837.com/en/standard" },
    { id: "superior", name: "Superior", sourceUrl: null },
  ];
}

describe("findMentionedAccommodation", () => {
  it("[direct match] resolves 'la Deluxe' to Deluxe, with its real source_url", () => {
    const result = findMentionedAccommodation("la Deluxe a la climatisation ?", le1837Lookups());
    expect(result?.id).toBe("deluxe");
    expect(result?.sourceUrl).toBe("https://www.le1837.com/en/deluxe");
  });

  it("[collision] 'Deluxe' is a substring-word of 'Deluxe PMR' — the MORE SPECIFIC (longer) name wins, never the shorter one", () => {
    const result = findMentionedAccommodation("la Deluxe PMR est-elle adaptée ?", le1837Lookups());
    expect(result?.id).toBe("deluxe-pmr");
    expect(result?.name).toBe("Deluxe PMR");
  });

  it("[collision, sourceUrl null] Deluxe PMR resolves correctly but carries sourceUrl: null — callers must fall back to unscoped RAG for it, never confuse it with Deluxe's own page", () => {
    const result = findMentionedAccommodation("je veux la Deluxe PMR", le1837Lookups());
    expect(result?.id).toBe("deluxe-pmr");
    expect(result?.sourceUrl).toBeNull();
  });

  it("[no false cross-match] 'Junior PMR' never resolves to 'Junior Suite' — they share a prefix word but never the same phrase", () => {
    const result = findMentionedAccommodation("je veux voir la Junior PMR", le1837Lookups());
    expect(result?.id).toBe("junior-pmr");
  });

  it("[no false cross-match, other direction] 'Junior Suite' never resolves to 'Junior PMR'", () => {
    const result = findMentionedAccommodation("je veux voir la Junior Suite", le1837Lookups());
    expect(result?.id).toBe("junior-suite");
  });

  it("[plain Deluxe, no PMR present] resolves to Deluxe alone when 'PMR' isn't in the message at all", () => {
    const result = findMentionedAccommodation("combien coûte la Deluxe ?", le1837Lookups());
    expect(result?.id).toBe("deluxe");
  });

  it("[no match] a message naming no real category returns null", () => {
    expect(findMentionedAccommodation("avez-vous un parking ?", le1837Lookups())).toBeNull();
  });

  it("[empty list] never matches anything", () => {
    expect(findMentionedAccommodation("la Deluxe", [])).toBeNull();
  });
});
