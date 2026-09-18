import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveAuthoritativeAccommodationId } from "./answer";
import { findMentionedAccommodation } from "./accommodationRanking";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Part B of this chantier — a real, confirmed bug: "la Deluxe fait quelle
 * surface ?" resolved Deluxe deterministically (findMentionedAccommodation),
 * yet roomRecommendation ended up pointing at Deluxe PMR because the
 * model's own free-choice recommendedAccommodationTypeId was the only thing
 * ever consulted for it. resolveAuthoritativeAccommodationId is the fix:
 * a deterministic match on the CURRENT message always outranks the model's
 * own proposal.
 */
describe("resolveAuthoritativeAccommodationId", () => {
  it("[the bug, fixed] a deterministic match wins even when the model proposes something else entirely", () => {
    expect(resolveAuthoritativeAccommodationId("deluxe-id", "deluxe-pmr-id")).toBe("deluxe-id");
  });

  it("[no deterministic match] falls back to the model's own proposal, unchanged from today's existing behavior", () => {
    expect(resolveAuthoritativeAccommodationId(null, "deluxe-id")).toBe("deluxe-id");
  });

  it("[neither] null when nothing was identified either way", () => {
    expect(resolveAuthoritativeAccommodationId(null, null)).toBeNull();
  });

  it("[deterministic match, model proposes nothing] the deterministic id is still used", () => {
    expect(resolveAuthoritativeAccommodationId("deluxe-id", null)).toBe("deluxe-id");
  });

  it("[deterministic match agrees with the model] no conflict, same id either way", () => {
    expect(resolveAuthoritativeAccommodationId("deluxe-id", "deluxe-id")).toBe("deluxe-id");
  });
});

/**
 * End-to-end reproduction chaining the two REAL functions involved —
 * findMentionedAccommodation (already validated for collisions in
 * accommodationRanking.test.ts) feeding resolveAuthoritativeAccommodationId
 * — covering every scenario this chantier's report explicitly requires.
 */
describe("end-to-end: message -> findMentionedAccommodation -> resolveAuthoritativeAccommodationId", () => {
  const lookups = [
    { id: "deluxe-id", name: "Deluxe", sourceUrl: "https://www.le1837.com/en/deluxe" },
    { id: "deluxe-pmr-id", name: "Deluxe PMR", sourceUrl: null },
    { id: "junior-suite-id", name: "Junior Suite", sourceUrl: "https://www.le1837.com/en/junior-suite" },
    { id: "junior-pmr-id", name: "Junior PMR", sourceUrl: "https://www.le1837.com/en/junior-pmr" },
  ];

  function resolveForMessage(message: string, modelProposedId: string | null): string | null {
    const mentioned = findMentionedAccommodation(message, lookups);
    return resolveAuthoritativeAccommodationId(mentioned?.id ?? null, modelProposedId);
  }

  it("[the exact reported bug] 'la Deluxe fait quelle surface ?' -> Deluxe, even if the model proposes Deluxe PMR", () => {
    expect(resolveForMessage("la Deluxe fait quelle surface ?", "deluxe-pmr-id")).toBe("deluxe-id");
  });

  it("'la Deluxe a la climatisation ?' -> Deluxe, even if the model proposes something else", () => {
    expect(resolveForMessage("la Deluxe a la climatisation ?", "junior-suite-id")).toBe("deluxe-id");
  });

  it("[collision] 'je veux voir la Junior Suite' -> Junior Suite, NEVER Junior PMR, even if the model proposes Junior PMR", () => {
    expect(resolveForMessage("je veux voir la Junior Suite", "junior-pmr-id")).toBe("junior-suite-id");
  });

  it("[collision, reverse] 'la Deluxe PMR ...' -> Deluxe PMR, NEVER Deluxe, even if the model proposes Deluxe", () => {
    expect(resolveForMessage("la Deluxe PMR est-elle adaptée ?", "deluxe-id")).toBe("deluxe-pmr-id");
  });

  it("[collision, reverse] 'la Junior PMR ...' -> Junior PMR, NEVER Junior Suite, even if the model proposes Junior Suite", () => {
    expect(resolveForMessage("la Junior PMR convient-elle ?", "junior-suite-id")).toBe("junior-pmr-id");
  });

  it("[generic question, no precise category] 'montre-moi les chambres' -> no deterministic override, falls back to whatever the model itself proposes", () => {
    expect(resolveForMessage("montre-moi les chambres", "deluxe-id")).toBe("deluxe-id");
    expect(resolveForMessage("montre-moi les chambres", null)).toBeNull();
  });

  it("[model agrees with the deterministic resolution] no conflict, same outcome either way", () => {
    expect(resolveForMessage("la Deluxe fait quelle surface ?", "deluxe-id")).toBe("deluxe-id");
  });
});

/**
 * Source-level wiring — buildRoomRecommendation() can't be unit-tested
 * directly here (Supabase-touching, room_photos query) — same constraint as
 * every other answer.ts test file. Confirms mentionedAccommodationId is
 * threaded from mentionedAccommodation (the same one ROOM_DISCOVERY/OPTION 2
 * already resolve) into answerGrounded, and that buildRoomRecommendation
 * actually calls resolveAuthoritativeAccommodationId rather than using
 * recommendedAccommodationTypeId directly.
 */
describe("answer.ts wiring — roomRecommendation authority", () => {
  it("[single detection, reused] mentionedAccommodation?.id ?? null is passed into answerGrounded's mentionedAccommodationId param — the SAME mentionedAccommodation already used for Option 2's scoped retrieval and ROOM_DISCOVERY's mentionsPreciseAccommodation, never a second lookup", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/mentionedAccommodationId: mentionedAccommodation\?\.id \?\? null,/);

    // answerNoContext never builds a roomRecommendation at all — must NOT receive this field.
    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).not.toMatch(/mentionedAccommodationId/);
  });

  it("[buildRoomRecommendation uses the authority function] never reads recommendedAccommodationTypeId directly for the match — always through resolveAuthoritativeAccommodationId", () => {
    const fnStart = source.indexOf("async function buildRoomRecommendation");
    const fnEnd = source.indexOf("\n}", source.indexOf("return {", fnStart));
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toMatch(/const effectiveAccommodationTypeId = resolveAuthoritativeAccommodationId\(mentionedAccommodationId, recommendedAccommodationTypeId\);/);
    expect(fn).toMatch(/rankedCandidates\.find\(\(c\) => c\.id === effectiveAccommodationTypeId\)/);
    expect(fn).not.toMatch(/rankedCandidates\.find\(\(c\) => c\.id === recommendedAccommodationTypeId\)/);
  });

  it("[call site threads mentionedAccommodationId into buildRoomRecommendation]", () => {
    const callStart = source.indexOf("const roomRecommendation = await buildRoomRecommendation(supabase, {");
    const callEnd = source.indexOf("});", callStart);
    expect(source.slice(callStart, callEnd)).toMatch(/mentionedAccommodationId,/);
  });

  it("[still validated against rankedCandidates — capacity-incompatible deterministic matches never bypass the filter] a precise mention that isn't in rankedCandidates yields no recommendation, never a silent fallback to the model's own choice", () => {
    // Documented via resolveAuthoritativeAccommodationId's own unit tests above (returns the deterministic id
    // unconditionally) plus buildRoomRecommendation's unchanged `if (!matched) return null;` guard — verified by
    // source inspection since buildRoomRecommendation itself needs Supabase to run end-to-end.
    const fnStart = source.indexOf("async function buildRoomRecommendation");
    const fnEnd = source.indexOf("\n}", source.indexOf("return {", fnStart));
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).toMatch(/if \(!matched\) return null;/);
  });
});
