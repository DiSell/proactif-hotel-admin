import { describe, expect, it } from "vitest";
import { applyAvailabilityToCandidates } from "./applyAvailabilityToCandidates";
import type { RankedCandidate } from "../rag/accommodationRanking";
import type { AvailabilityCheckState, AvailabilityResult } from "./types";

function ranked(id: string, fit: "known" | "unknown" = "known"): RankedCandidate {
  return { id, name: id, maxGuests: null, maxAdults: null, maxChildren: null, fit };
}

function checkedState(items: AvailabilityResult["items"]): AvailabilityCheckState {
  return {
    kind: "checked",
    result: { integrationId: "int-1", provider: "test", checkedAt: new Date().toISOString(), availabilityStatus: "UNKNOWN", items },
  };
}

describe("applyAvailabilityToCandidates", () => {
  it("[not checked] returns the business-filtered list unchanged when no availability check ran", () => {
    const candidates = [ranked("a"), ranked("b")];
    expect(applyAvailabilityToCandidates(candidates, { kind: "not_requested" })).toEqual(candidates);
    expect(applyAvailabilityToCandidates(candidates, { kind: "no_provider" })).toEqual(candidates);
    expect(applyAvailabilityToCandidates(candidates, { kind: "missing_input", missingFields: ["checkIn"] })).toEqual(candidates);
  });

  it("[A] business-compatible + AVAILABLE -> allowed", () => {
    const state = checkedState([{ externalAccommodationId: "a", availabilityStatus: "AVAILABLE" }]);
    const result = applyAvailabilityToCandidates([ranked("a")], state);
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });

  it("[B] business-compatible + UNAVAILABLE -> excluded", () => {
    const state = checkedState([{ externalAccommodationId: "b", availabilityStatus: "UNAVAILABLE" }]);
    const result = applyAvailabilityToCandidates([ranked("b")], state);
    expect(result).toHaveLength(0);
  });

  it("[C] business-compatible + UNKNOWN -> never presented as confirmed available", () => {
    const state = checkedState([{ externalAccommodationId: "c", availabilityStatus: "UNKNOWN" }]);
    const result = applyAvailabilityToCandidates([ranked("c")], state);
    expect(result).toHaveLength(0);
  });

  it("a candidate absent from the provider's response entirely is also excluded from confirmed-available", () => {
    const state = checkedState([{ externalAccommodationId: "other", availabilityStatus: "AVAILABLE" }]);
    const result = applyAvailabilityToCandidates([ranked("missing-from-response")], state);
    expect(result).toHaveLength(0);
  });

  it("[D] business-incompatible candidates are never passed in, so availability can never reintroduce them — this function only narrows", () => {
    // Simulates: D was already excluded upstream by filterAndRankAccommodations (capacity),
    // so it never even reaches this function's input.
    const rankedCandidatesAfterBusinessFilter = [ranked("survivor")]; // D is not in this list
    const state = checkedState([
      { externalAccommodationId: "survivor", availabilityStatus: "AVAILABLE" },
      { externalAccommodationId: "D", availabilityStatus: "AVAILABLE" }, // even if the provider says D is available...
    ]);
    const result = applyAvailabilityToCandidates(rankedCandidatesAfterBusinessFilter, state);
    // ...D never appears, because it was never a candidate in the first place.
    expect(result.map((r) => r.id)).toEqual(["survivor"]);
  });

  it("heterogeneous items (A=AVAILABLE, B=UNAVAILABLE, C=UNKNOWN) resolve independently per candidate", () => {
    const state = checkedState([
      { externalAccommodationId: "a", availabilityStatus: "AVAILABLE" },
      { externalAccommodationId: "b", availabilityStatus: "UNAVAILABLE" },
      { externalAccommodationId: "c", availabilityStatus: "UNKNOWN" },
    ]);
    const result = applyAvailabilityToCandidates([ranked("a"), ranked("b"), ranked("c")], state);
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });
});
