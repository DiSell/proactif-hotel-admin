import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Regression guards for the "partenaires recommandés par l'hôtel" chatbot
 * integration — answerQuestion() can't be unit-tested directly here (needs
 * Supabase + OpenAI, no mocking infrastructure — see
 * answer.groundingMode.test.ts's own comment for the same constraint), so
 * these check the source-level shape. Pure logic (ranking/cap/CTA/intent
 * detection) is exercised with real assertions in partners.test.ts.
 */
function sliceFn(name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}`) !== -1 ? source.indexOf(`async function ${name}`) : source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(nextName === "EOF" ? "\0" : nextName, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe("answerQuestion — partner intent orthogonal to groundingMode", () => {
  it("[computed once, before branching] partnerIntentDetected/partnerCandidates are computed in answerQuestion itself, not duplicated per branch", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    expect(fn).toMatch(/const partnerIntentDetected = isPartnerIntent\(message\);/);
    expect(fn).toMatch(/let partnerCandidates: HotelPartner\[\] = \[\];/);
    expect(fn).toMatch(/if \(partnerIntentDetected\) \{/);
  });

  it("[cap enforced server-side before the model call] the limit passed to rankPartnerCandidates is DEFAULT_PARTNER_LIMIT, raised to ALL_PARTNERS_LIMIT only on an explicit request — never left for the model to self-limit", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    expect(fn).toMatch(/const limit = wantsAllPartners\(message\) \? ALL_PARTNERS_LIMIT : DEFAULT_PARTNER_LIMIT;/);
    expect(fn).toMatch(/rankPartnerCandidates\(allPartners, \{ category, limit \}\)/);
  });

  it("[loaded only when intent detected] loadActiveHotelPartners is never called unconditionally — most turns have nothing to do with a partner", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    const guardIndex = fn.indexOf("if (partnerIntentDetected) {");
    const loadIndex = fn.indexOf("loadActiveHotelPartners(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(guardIndex);
  });

  it("[threaded to both branches] both answerGrounded and answerNoContext receive partnerIntentDetected and partnerCandidates", () => {
    const answerQuestionFn = sliceFn("answerQuestion", "type HistoryInputItem");
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/partnerIntentDetected,\s*\n\s*partnerCandidates,/);

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/partnerIntentDetected,\s*\n\s*partnerCandidates,/);
  });
});

describe("buildPartnerRecommendations — never trusts a raw model id", () => {
  it("[validated against the exact candidate list] filters recommendedPartnerIds against partnerCandidates by id, mirroring buildRoomRecommendation's discipline", () => {
    const fn = sliceFn("buildPartnerRecommendations", "async function answerGrounded");
    expect(fn).toMatch(/const partner = byId\.get\(id\);/);
    expect(fn).toMatch(/if \(!partner\) continue;/);
  });

  it("[empty/null input -> empty output] a null or empty recommendedPartnerIds never throws, just returns []", () => {
    const fn = sliceFn("buildPartnerRecommendations", "async function answerGrounded");
    expect(fn).toMatch(/if \(!recommendedPartnerIds \|\| recommendedPartnerIds\.length === 0\) return \[\];/);
  });

  it("[no duplicate recommendations] a repeated id in the model's own output never produces two entries for the same partner", () => {
    const fn = sliceFn("buildPartnerRecommendations", "async function answerGrounded");
    expect(fn).toMatch(/if \(seen\.has\(id\)\) continue;/);
  });
});

describe("answerGrounded / answerNoContext — partner wiring", () => {
  it("[grounded] extracts recommendedPartnerIds from the structured response and builds partnerRecommendations from it", () => {
    const fn = sliceFn("answerGrounded", "async function answerNoContext");
    expect(fn).toMatch(/recommendedPartnerIds = response\.output_parsed\.recommendedPartnerIds;/);
    expect(fn).toMatch(/const partnerRecommendations = buildPartnerRecommendations\(recommendedPartnerIds, partnerCandidates\);/);
  });

  it("[no_context] same extraction + build, independent of groundingMode", () => {
    const fn = sliceFn("answerNoContext", "async function loadHistory");
    expect(fn).toMatch(/recommendedPartnerIds = response\.output_parsed\.recommendedPartnerIds;/);
    expect(fn).toMatch(/const partnerRecommendations = buildPartnerRecommendations\(recommendedPartnerIds, partnerCandidates\);/);
  });

  it("[error path] finalizeError always returns an empty partnerRecommendations array, never omits the field", () => {
    const fn = sliceFn("finalizeError", "EOF");
    expect(fn).toMatch(/partnerRecommendations: \[\]/);
  });
});

describe("hotel_partners never pollutes accommodation/RAG logic", () => {
  const partnersSource = readFileSync(join(here, "partners.ts"), "utf8");

  it("[independent read path] loadActiveHotelPartners reads hotel_partners only, never joined with accommodation_types or knowledge_sources logic", () => {
    expect(partnersSource).toMatch(/\.from\("hotel_partners"\)/);
    expect(partnersSource).not.toMatch(/\.from\("accommodation_types"\)/);
    expect(partnersSource).not.toMatch(/\.from\("knowledge_sources"\)/);
    expect(partnersSource).not.toMatch(/\.from\("knowledge_chunks"\)/);
  });

  it("[consent gate] loadActiveHotelPartners filters on consent_status = \"accepted\" in addition to is_active — an active-but-unconsenting partner is never returned", () => {
    const fn = partnersSource.slice(partnersSource.indexOf("export async function loadActiveHotelPartners"));
    expect(fn).toMatch(/\.eq\("is_active", true\)/);
    expect(fn).toMatch(/\.eq\("consent_status", "accepted"\)/);
  });

  it("[answer.ts imports the partner logic, never reimplements it inline]", () => {
    const partnersImportLine = source.split("\n").find((line) => line.includes('from "./partners"'));
    expect(partnersImportLine).toBeTruthy();
    expect(source).not.toMatch(/\.from\("hotel_partners"\)/);
  });
});
