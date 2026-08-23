import { describe, expect, it } from "vitest";
import { filterAndRankAccommodations, isCapacityCompatible, type AccommodationCandidate } from "./accommodationRanking";
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
