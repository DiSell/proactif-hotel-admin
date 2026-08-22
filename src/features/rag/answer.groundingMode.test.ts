import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Regression guards for the grounded / no_context split. answerQuestion()
 * can't be unit-tested directly here (it needs Supabase + OpenAI, and this
 * codebase has no mocking infrastructure for either — see
 * similarityThreshold.test.ts for the same constraint), so these check the
 * source-level shape that the fix requires instead.
 */
describe("answerQuestion — grounded / no_context split", () => {
  it("[A] no longer short-circuits to a static fallback before calling the model when no chunks are found", () => {
    // The old anti-pattern: an early return of a canned reply, gated only
    // on relevantChunks.length === 0, with no OpenAI call anywhere near it.
    expect(source).not.toMatch(/relevantChunks\.length === 0\)\s*\{\s*\n\s*const reply = settings/);

    // The new shape: both branches are real, separate functions that each
    // call the OpenAI client — "no chunks" no longer means "no model call".
    const groundedFn = source.slice(source.indexOf("async function answerGrounded"), source.indexOf("async function answerNoContext"));
    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(groundedFn).toMatch(/getOpenAIClient\(/);
    expect(noContextFn).toMatch(/getOpenAIClient\(/);
  });

  it("[C] only the grounded branch ever builds a knowledge reference block — no_context never gets one", () => {
    const callSites = source.match(/buildKnowledgeReferenceBlock\(/g) || [];
    expect(callSites.length).toBe(1);

    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(noContextFn).not.toMatch(/buildKnowledgeReferenceBlock/);
  });

  it("[F] no_context self-classifies answerStatus via structured output instead of a hardcoded status", () => {
    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(noContextFn).toMatch(/zodTextFormat\(noContextReplySchema/);
    expect(noContextFn).toMatch(/answerStatus = response\.output_parsed\.answerStatus/);
    // Unlike the grounded branch, which can hardcode "answered" because
    // finding relevant chunks is itself the signal.
    const groundedFn = source.slice(source.indexOf("async function answerGrounded"), source.indexOf("async function answerNoContext"));
    expect(groundedFn).toMatch(/answerStatus:\s*"answered"/);
  });

  it("groundingMode is computed from relevantChunks.length, not hardcoded, and drives which branch runs", () => {
    expect(source).toMatch(/groundingMode:\s*GroundingMode\s*=\s*relevantChunks\.length > 0 \? "grounded" : "no_context"/);
  });
});
