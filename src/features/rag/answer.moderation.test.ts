import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Regression guards for the model self-report -> flag_conversation()
 * wiring — same source-level convention as answer.partnerRequestFlow.test.ts
 * (answerQuestion/answerGrounded/answerNoContext can't be unit-tested
 * directly here, they need Supabase + OpenAI). applyModerationFlag's actual
 * best-effort/idempotency behavior is unit-tested with real invocation in
 * moderation.test.ts, since that module takes only a SupabaseClient and is
 * fully mockable.
 */
function sliceFn(name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}`) !== -1 ? source.indexOf(`async function ${name}`) : source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(nextName, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe("structured output schemas — moderation extension, shared by both branches", () => {
  it("[shared field set] moderationOutputFields is spread into BOTH groundedReplySchema and noContextReplySchema", () => {
    expect(source).toMatch(/const groundedReplySchema = z\.object\(\{[\s\S]*?\.\.\.moderationOutputFields,[\s\S]*?\}\);/);
    expect(source).toMatch(/const noContextReplySchema = z\.object\(\{[\s\S]*?\.\.\.moderationOutputFields,[\s\S]*?\}\);/);
  });

  it("[exact field list] flaggedAsAbusive (boolean) and flagReason (nullable string) only", () => {
    const fieldsBlock = source.slice(source.indexOf("const moderationOutputFields"), source.indexOf("};", source.indexOf("const moderationOutputFields")));
    expect(fieldsBlock).toMatch(/flaggedAsAbusive:\s*z\.boolean\(\)/);
    expect(fieldsBlock).toMatch(/flagReason:\s*z\.string\(\)\.nullable\(\)/);
  });
});

describe("applyModerationFlag", () => {
  it("[no-op when not flagged] returns without calling flagConversationForModeration", () => {
    const fn = sliceFn("applyModerationFlag", "async function answerQuestion");
    expect(fn).toMatch(/if \(!modelOutput\.flaggedAsAbusive\) return;/);
  });

  it("[defensive fallback reason] never passes a null/empty reason to flagConversationForModeration", () => {
    const fn = sliceFn("applyModerationFlag", "async function answerQuestion");
    expect(fn).toMatch(/modelOutput\.flagReason\?\.trim\(\) \|\| "comportement signalé par l'assistant"/);
  });

  it("[awaited, not fire-and-forget]", () => {
    const fn = sliceFn("applyModerationFlag", "async function answerQuestion");
    expect(fn).toMatch(/await flagConversationForModeration\(/);
  });
});

describe("answerGrounded / answerNoContext — moderation wiring", () => {
  it("[grounded] applyModerationFlag is called unconditionally, right after output_parsed, BEFORE the partner/spa flow branching", () => {
    const fn = sliceFn("answerGrounded", "async function answerNoContext");
    const moderationIndex = fn.indexOf("await applyModerationFlag(hotelId, conversationId, response.output_parsed, supabase);");
    const partnerBranchIndex = fn.indexOf("if (partnerRequestFlowActive) {");
    expect(moderationIndex).toBeGreaterThan(-1);
    expect(partnerBranchIndex).toBeGreaterThan(-1);
    expect(moderationIndex).toBeLessThan(partnerBranchIndex);
  });

  it("[no_context] same unconditional wiring, independent of groundingMode", () => {
    const fn = sliceFn("answerNoContext", "async function loadHistory");
    const moderationIndex = fn.indexOf("await applyModerationFlag(hotelId, conversationId, response.output_parsed, supabase);");
    const partnerBranchIndex = fn.indexOf("if (partnerRequestFlowActive) {");
    expect(moderationIndex).toBeGreaterThan(-1);
    expect(partnerBranchIndex).toBeGreaterThan(-1);
    expect(moderationIndex).toBeLessThan(partnerBranchIndex);
  });
});
