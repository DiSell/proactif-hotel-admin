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
 */
describe("similarity threshold — single source of truth", () => {
  it("is a single adjustable exported constant", () => {
    expect(typeof DEFAULT_SIMILARITY_THRESHOLD).toBe("number");
  });

  it("answer.ts imports DEFAULT_SIMILARITY_THRESHOLD from retrieve.ts and never hardcodes a second numeric threshold", () => {
    const source = readFileSync(join(here, "answer.ts"), "utf8");
    expect(source).toMatch(/import\s*\{[^}]*DEFAULT_SIMILARITY_THRESHOLD[^}]*\}\s*from\s*["']\.\/retrieve["']/);
    expect(source).toMatch(/selectRelevantChunks\(\s*chunks\s*,\s*DEFAULT_SIMILARITY_THRESHOLD\s*\)/);
    expect(source).not.toMatch(/selectRelevantChunks\([^)]*,\s*0\.\d+\s*\)/);
  });
});
