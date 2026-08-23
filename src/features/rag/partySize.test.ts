import { describe, expect, it } from "vitest";
import { extractPartySize } from "./partySize";

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
});
