import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_SIMILARITY_THRESHOLD } from "./retrieve";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Regression guard: the whole pipeline must read the relevance cutoff from
 * exactly one place — DEFAULT_SIMILARITY_THRESHOLD in retrieve.ts. answer.ts
 * can't be unit-tested directly here (it needs Supabase + OpenAI), so this
 * asserts at the source level that it imports and uses the shared constant
 * rather than a second hardcoded number that could silently diverge from it.
 *
 * answer.ts now calls selectHybridRelevantChunks (not selectRelevantChunks
 * directly) — DEFAULT_SIMILARITY_THRESHOLD stays the single source of truth
 * because selectHybridRelevantChunks' own Rule 1 defaults its
 * vectorThreshold option to exactly this constant (see retrieve.ts) rather
 * than a second hardcoded number; answer.ts calls it with no override,
 * relying on that default, which is what the assertion below checks.
 */
describe("similarity threshold — single source of truth", () => {
  it("is a single adjustable exported constant", () => {
    expect(typeof DEFAULT_SIMILARITY_THRESHOLD).toBe("number");
  });

  it("answer.ts calls selectHybridRelevantChunks with no numeric override, relying on its DEFAULT_SIMILARITY_THRESHOLD-sourced default — never a second hardcoded threshold", () => {
    const source = readFileSync(join(here, "answer.ts"), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*retrieveKnowledgeHybrid[^}]*selectHybridRelevantChunks[^}]*\}\s*from\s*["']\.\/retrieve["']/);
    expect(source).toMatch(/selectHybridRelevantChunks\(\s*chunks\s*\)/);
    expect(source).not.toMatch(/selectHybridRelevantChunks\([^)]*0\.\d+/);
  });

  it("selectHybridRelevantChunks itself (retrieve.ts) defaults Rule 1's vectorThreshold to DEFAULT_SIMILARITY_THRESHOLD, never a second hardcoded number", () => {
    const source = readFileSync(join(here, "retrieve.ts"), "utf8");
    expect(source).toMatch(/vectorThreshold\s*=\s*options\.vectorThreshold\s*\?\?\s*DEFAULT_SIMILARITY_THRESHOLD/);
  });
});
