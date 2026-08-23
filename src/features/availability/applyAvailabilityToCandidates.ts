import type { RankedCandidate } from "../rag/accommodationRanking";
import type { AvailabilityCheckState } from "./types";

/**
 * Phase A simplification, documented explicitly: AvailabilityItem.externalAccommodationId
 * is treated as directly comparable to our internal accommodation_type id.
 * Phase B's accommodation_inventory_mappings will introduce a real
 * external/internal mapping (a hotel's PMS id is rarely the same string as
 * our UUID) — until a real provider exists to disagree, this is the
 * simplest correct behavior and avoids building an unused mapping layer
 * with zero real callers today.
 *
 * Availability filters candidates SERVER-SIDE, not only via the prompt
 * guidance text (prompt.ts) — this is the actual enforcement point.
 * checkState.kind !== "checked" leaves business filtering (capacity, see
 * accommodationRanking.ts) as the only constraint, unchanged. Once
 * "checked": AVAILABLE is kept; UNAVAILABLE is excluded, never
 * reintroduced; UNKNOWN (or an accommodation absent from the provider's
 * response entirely) is also excluded from "confirmed available" — not
 * because it's known to be unavailable, but because it can't be presented
 * as a verified match. The business-compatible list already computed by
 * filterAndRankAccommodations is never widened here, only ever narrowed
 * further: a candidate already excluded by capacity can never come back
 * because a provider happened to report it AVAILABLE.
 */
export function applyAvailabilityToCandidates(rankedCandidates: RankedCandidate[], checkState: AvailabilityCheckState): RankedCandidate[] {
  if (checkState.kind !== "checked") return rankedCandidates;

  const statusById = new Map(checkState.result.items.map((item) => [item.externalAccommodationId, item.availabilityStatus]));
  return rankedCandidates.filter((candidate) => statusById.get(candidate.id) === "AVAILABLE");
}
