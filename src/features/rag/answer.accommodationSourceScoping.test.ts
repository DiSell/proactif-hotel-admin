import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * OPTION 2 — additive, bounded retrieval scoped to a single already-
 * identified accommodation_type's own dedicated knowledge_source (see
 * retrieve.ts:fetchAccommodationSourceChunks/mergeGuaranteedChunks and
 * accommodationRanking.ts:findMentionedAccommodation). answerQuestion()
 * can't be unit-tested directly here (Supabase + OpenAI, no mocking infra
 * in this repo — same constraint as every other answer.ts test file), so
 * this checks the source-level wiring: the exact ordering the diagnostic
 * for this chantier showed is load-bearing (accommodation_types must be
 * fetched, and the accommodation identified, BEFORE relevantChunks is
 * finalized; the scoped merge must happen AFTER selectHybridRelevantChunks,
 * never before it, or the same threshold that dropped the real chunks in
 * the first place would just drop them again).
 */
describe("answer.ts wiring — accommodation-scoped retrieval (OPTION 2)", () => {
  const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));

  it("[detection reused, not duplicated] findMentionedAccommodation is the single call feeding both mentionedAccommodation and mentionsPreciseAccommodation", () => {
    const occurrences = source.match(/findMentionedAccommodation\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(answerQuestionFn).toMatch(/const mentionedAccommodation = findMentionedAccommodation\(/);
    expect(answerQuestionFn).toMatch(/const mentionsPreciseAccommodation = mentionedAccommodation !== null;/);
  });

  it("[ordering] accommodation_types is fetched and mentionedAccommodation resolved BEFORE the retrieval try block, not after", () => {
    const accTypesFetchIndex = answerQuestionFn.indexOf('.from("accommodation_types")');
    const mentionedIndex = answerQuestionFn.indexOf("const mentionedAccommodation = findMentionedAccommodation(");
    const retrievalCallIndex = answerQuestionFn.indexOf("await retrieveKnowledgeHybrid(");
    expect(accTypesFetchIndex).toBeGreaterThan(-1);
    expect(accTypesFetchIndex).toBeLessThan(mentionedIndex);
    expect(mentionedIndex).toBeLessThan(retrievalCallIndex);
  });

  it("[insertion point — the critical fix] the scoped merge happens AFTER selectHybridRelevantChunks, never before it — merging before would let the exact same threshold that dropped the real chunks drop them again", () => {
    const selectIndex = answerQuestionFn.indexOf("relevantChunks = selectHybridRelevantChunks(chunks);");
    const mergeCallIndex = answerQuestionFn.indexOf("relevantChunks = mergeGuaranteedChunks(relevantChunks, scopedChunks);");
    const fetchScopedIndex = answerQuestionFn.indexOf("await fetchAccommodationSourceChunks(");
    expect(selectIndex).toBeGreaterThan(-1);
    expect(mergeCallIndex).toBeGreaterThan(-1);
    expect(selectIndex).toBeLessThan(fetchScopedIndex);
    expect(fetchScopedIndex).toBeLessThan(mergeCallIndex);
  });

  it("[gated on a real source_url] the scoped fetch only runs when mentionedAccommodation.sourceUrl is truthy — never for Superior/Deluxe PMR (sourceUrl: null), which fall through to unscoped RAG unchanged", () => {
    expect(answerQuestionFn).toMatch(/if \(mentionedAccommodation\?\.sourceUrl\) \{/);
  });

  it("[groundingMode computed AFTER the merge] a turn where scoped retrieval is the ONLY source of relevant content must still be able to become 'grounded'", () => {
    const mergeCallIndex = answerQuestionFn.indexOf("relevantChunks = mergeGuaranteedChunks(relevantChunks, scopedChunks);");
    const groundingModeIndex = answerQuestionFn.indexOf('const groundingMode: GroundingMode = relevantChunks.length > 0 ? "grounded" : "no_context";');
    expect(groundingModeIndex).toBeGreaterThan(-1);
    expect(mergeCallIndex).toBeLessThan(groundingModeIndex);
  });

  it("[best-effort — never fails the turn] a failure in the scoped fetch is caught locally, not propagated to the outer retrieval catch", () => {
    const outerCatchIndex = answerQuestionFn.indexOf('console.error("answerQuestion: retrieval failed"');
    const scopedCatchIndex = answerQuestionFn.indexOf('console.error("answerQuestion: scoped accommodation retrieval failed"');
    expect(scopedCatchIndex).toBeGreaterThan(-1);
    expect(scopedCatchIndex).toBeLessThan(outerCatchIndex);
  });

  it("[ROOM_DISCOVERY untouched] roomDiscoveryIntentDetected is still computed independently, before and without depending on the new accommodation-scoping block", () => {
    expect(answerQuestionFn).toMatch(
      /const roomDiscoveryIntentDetected =\s*\n?\s*isRoomDiscoveryIntent\(message\) \|\| \(roomDiscoveryContinuationSignal && !isBookingIntent\(message\)\);/
    );
    const roomDiscoveryIndex = answerQuestionFn.indexOf("const roomDiscoveryIntentDetected =");
    const mentionedIndex = answerQuestionFn.indexOf("const mentionedAccommodation = findMentionedAccommodation(");
    expect(roomDiscoveryIndex).toBeGreaterThan(-1);
    expect(roomDiscoveryIndex).toBeLessThan(mentionedIndex);
  });
});
