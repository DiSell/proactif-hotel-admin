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
