import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isAccommodationInformationIntent, isAccommodationRecommendationIntent, isRoomDiscoveryIntent } from "./accommodationRanking";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * INFORMATION DÉTERMINISTE chantier (audit "INFORMATION HÉBERGEMENTS
 * DÉTERMINISTE" -> implementation). Source-level wiring, same constraint as
 * every other answer.ts test file in this repo (Supabase + OpenAI, no
 * mocking infra) — real invocation is used wherever the logic is pure
 * (the three intent detectors), source assertions for the orchestration
 * itself.
 */
describe("answer.ts wiring — informationIntentDetected", () => {
  it("[wired for the first time] isAccommodationInformationIntent is actually called in answer.ts — it existed since the 3-INTENTIONS chantier but was never wired into the pipeline before this chantier", () => {
    expect(source).toMatch(/isAccommodationInformationIntent\(message\)/);
  });

  it("[mutually exclusive by construction] informationIntentDetected is guarded by !roomDiscoveryIntentDetected && !recommendationIntentDetected — never true the same turn as CATALOGUE or RECOMMENDATION", () => {
    expect(source).toMatch(
      /const informationIntentDetected =\s*\n\s*!roomDiscoveryIntentDetected && !recommendationIntentDetected && isAccommodationInformationIntent\(message\);/
    );
  });

  it("[no continuation marker] unlike recommendationIntentDetected, informationIntentDetected has no continuation signal — INFORMATION never asks a question, so there is nothing to persist across turns", () => {
    const flagIndex = source.indexOf("const informationIntentDetected =");
    const flagLine = source.slice(flagIndex, source.indexOf(";", flagIndex));
    expect(flagLine).not.toMatch(/[Cc]ontinuation/);
  });
});

describe("answer.ts wiring — accommodationSummary", () => {
  it("[deterministic, built from candidates directly] never through filterAndRankAccommodations/catalogueRankedCandidates — INFORMATION is never capacity-filtered, unlike CATALOGUE", () => {
    const computeStart = source.indexOf("const accommodationSummary: RoomCatalogueEntry[] = informationIntentDetected");
    expect(computeStart).toBeGreaterThan(-1);
    const block = source.slice(computeStart, source.indexOf(";", source.indexOf("[]", computeStart)) + 1);
    expect(block).toMatch(/candidates\.map/);
    expect(block).not.toMatch(/catalogueRankedCandidates/);
    expect(block).not.toMatch(/filterAndRankAccommodations/);
  });

  it("[same entry shape as roomCatalogue, never a second parallel type] accommodationTypeId/name/pageUrl/maxGuests, no price field anywhere in this block", () => {
    const computeStart = source.indexOf("const accommodationSummary: RoomCatalogueEntry[] = informationIntentDetected");
    const block = source.slice(computeStart, computeStart + 400);
    expect(block).toMatch(/accommodationTypeId: c\.id,/);
    expect(block).toMatch(/name: c\.name,/);
    expect(block).toMatch(/pageUrl: accommodationTypesById\.get\(c\.id\)\?\.source_url \?\? null,/);
    expect(block).toMatch(/maxGuests: c\.maxGuests,/);
    expect(block).not.toMatch(/price/i);
  });

  it("[gate is exactly informationIntentDetected, nothing else] never also requires !mentionsPreciseAccommodation or isPartyKnown — isAccommodationInformationIntent's own pattern already excludes precise-category mentions structurally", () => {
    const computeStart = source.indexOf("const accommodationSummary: RoomCatalogueEntry[] = informationIntentDetected");
    const ternaryStart = source.indexOf("?", computeStart);
    const gateExpr = source.slice(computeStart, ternaryStart);
    expect(gateExpr).toMatch(/informationIntentDetected/);
    expect(gateExpr).not.toMatch(/mentionsPreciseAccommodation/);
    expect(gateExpr).not.toMatch(/isPartyKnown/);
  });

  it("[threaded into both branches] answerGrounded and answerNoContext both receive accommodationSummary, and both return it", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/accommodationSummary,/);

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/accommodationSummary,/);

    expect(source).toMatch(/roomCatalogue, accommodationSummary, hotelMediaGallery \};/);
  });

  it("[error path] the generic error fallback always returns an empty accommodationSummary, never omitted/undefined", () => {
    expect(source).toMatch(/roomCatalogue: \[\], accommodationSummary: \[\], hotelMediaGallery: null \};/);
  });

  it("[never gated on groundingMode] computed once in answerQuestion, before the grounded/no_context branch decision — independent of retrieval, exactly like roomCatalogue", () => {
    const computeStart = source.indexOf("const accommodationSummary: RoomCatalogueEntry[] = informationIntentDetected");
    const branchIndex = source.indexOf('if (groundingMode === "grounded")');
    expect(computeStart).toBeGreaterThan(-1);
    expect(computeStart).toBeLessThan(branchIndex);
  });
});

/**
 * TEST A/B/C (mission item 12) — real invocation of the three pure
 * detectors proving mutual exclusivity for the mission's own reference
 * messages, the same real functions answer.ts's informationIntentDetected/
 * roomDiscoveryIntentDetected/recommendationIntentDetected are built from.
 */
describe("TEST A/B/C — INFORMATION / CATALOGUE / RECOMMANDATION never overlap", () => {
  it("[A — INFORMATION] 'Quels types de chambres ou logements proposez-vous ?' -> information only", () => {
    const message = "Quels types de chambres ou logements proposez-vous ?";
    expect(isAccommodationInformationIntent(message)).toBe(true);
    expect(isRoomDiscoveryIntent(message)).toBe(false);
    expect(isAccommodationRecommendationIntent(message)).toBe(false);
  });

  it("[B — CATALOGUE] 'Montrez-moi vos logements.' -> catalogue only", () => {
    const message = "Montrez-moi vos logements.";
    expect(isRoomDiscoveryIntent(message)).toBe(true);
    expect(isAccommodationInformationIntent(message)).toBe(false);
    expect(isAccommodationRecommendationIntent(message)).toBe(false);
  });

  it("[C — RECOMMANDATION] 'Parmi ces logements, lequel me recommandez-vous pour 4 personnes ?' -> recommendation only", () => {
    const message = "Parmi ces logements, lequel me recommandez-vous pour 4 personnes ?";
    expect(isAccommodationRecommendationIntent(message)).toBe(true);
    expect(isRoomDiscoveryIntent(message)).toBe(false);
  });
});
