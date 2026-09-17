import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Regression guards for the "a room type gets silently dropped from RAG
 * retrieval" bug — confirmed live against a real hotel: knowledge_chunks
 * held full descriptions for every room type, but the default
 * RETRIEVAL_LIMIT (6) meant some never made the cut for a stay/party-size
 * question, since that hotel had no structured accommodation_types data and
 * its scraped room content was split into several redundant chunks per
 * room. answerQuestion() can't be unit-tested directly here (needs Supabase
 * + OpenAI, no mocking infra in this repo — same constraint as every other
 * answer.ts test file), so this checks the source-level shape.
 */
describe("answerQuestion — widened retrieval for stay/accommodation-relevant turns", () => {
  it("[single source of truth] shouldResolveStayContext(message) is computed ONCE, before retrieval, into stayContextRelevant — never called a second time later", () => {
    const occurrences = source.match(/shouldResolveStayContext\(message\)/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(source).toMatch(/const stayContextRelevant = shouldResolveStayContext\(message\);/);
  });

  it("[reused, not recomputed, for the stay-request block below] the later gate is `if (stayContextRelevant || roomDiscoveryIntentDetected)`, not a second shouldResolveStayContext(message) call", () => {
    expect(source).toMatch(/if \(stayContextRelevant \|\| roomDiscoveryIntentDetected\) \{/);
  });

  it("[computed before retrieval, not after] stayContextRelevant must exist before retrieveKnowledgeHybrid is ever called — a limit decided from it can't apply otherwise", () => {
    const gateIndex = source.indexOf("const stayContextRelevant = shouldResolveStayContext(message);");
    const retrieveIndex = source.indexOf("await retrieveKnowledgeHybrid({");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(retrieveIndex).toBeGreaterThan(gateIndex);
  });

  it("[widened limit wired into the actual call] retrieveKnowledgeHybrid's limit is a ternary on stayContextRelevant OR roomDiscoveryIntentDetected, never the flat RETRIEVAL_LIMIT alone", () => {
    const fn = source.slice(source.indexOf("await retrieveKnowledgeHybrid({"), source.indexOf("});", source.indexOf("await retrieveKnowledgeHybrid({")));
    expect(fn).toMatch(/limit: stayContextRelevant \|\| roomDiscoveryIntentDetected \? ACCOMMODATION_RETRIEVAL_LIMIT : RETRIEVAL_LIMIT,/);
  });

  it("[the widened limit is strictly larger] ACCOMMODATION_RETRIEVAL_LIMIT > RETRIEVAL_LIMIT — this must actually widen the candidate pool, never narrow or match it", () => {
    const retrievalLimitMatch = source.match(/const RETRIEVAL_LIMIT = (\d+);/);
    const accommodationLimitMatch = source.match(/const ACCOMMODATION_RETRIEVAL_LIMIT = (\d+);/);
    expect(retrievalLimitMatch).toBeTruthy();
    expect(accommodationLimitMatch).toBeTruthy();
    expect(Number(accommodationLimitMatch![1])).toBeGreaterThan(Number(retrievalLimitMatch![1]));
  });

  it("[relevance filtering is untouched] selectHybridRelevantChunks still runs on the result exactly as before — a wider candidate pool is never a bypass of the relevance threshold", () => {
    const fn = source.slice(source.indexOf("let relevantChunks: RetrievedChunk[];"), source.indexOf("const groundingMode"));
    expect(fn).toMatch(/relevantChunks = selectHybridRelevantChunks\(chunks\);/);
  });
});
