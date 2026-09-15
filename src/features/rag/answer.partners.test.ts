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
    expect(fn).toMatch(/let partnerCandidates: RagPartner\[\] = \[\];/);
    expect(fn).toMatch(/if \(partnerIntentDetected\) \{/);
  });

  it("[cap enforced server-side before the model call] the limit passed to rankPartnerCandidates is DEFAULT_PARTNER_LIMIT, raised to ALL_PARTNERS_LIMIT only on an explicit request — never left for the model to self-limit", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    expect(fn).toMatch(/const limit = wantsAllPartners\(message\) \? ALL_PARTNERS_LIMIT : DEFAULT_PARTNER_LIMIT;/);
    expect(fn).toMatch(/rankPartnerCandidates\(allPartners, \{ category, limit \}\)/);
  });

  it("[loaded only when relevant] loadActiveHotelPartners is never called unconditionally — most turns have nothing to do with a partner. Gated by partnerRequestFlowActive (partnerIntentDetected OR an active partner_request already exists for this conversation — see partnerRequestFlow.ts), a superset of partnerIntentDetected alone: a bare 'oui' confirming an in-progress request must still load the authoritative partner list even though it never matches isPartnerIntent's own keywords.", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    const guardIndex = fn.indexOf("if (partnerRequestFlowActive) {");
    const loadIndex = fn.indexOf("loadActiveHotelPartners(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(loadIndex).toBeGreaterThan(guardIndex);
  });

  it("[recommendation cap still gated by partnerIntentDetected specifically] partnerCandidates (the capped, display-only list) is only ever populated inside the narrower partnerIntentDetected check, even though allPartners (the uncapped, request-validation list) loads under the broader gate", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    const broadGuardIndex = fn.indexOf("if (partnerRequestFlowActive) {");
    const narrowGuardIndex = fn.indexOf("if (partnerIntentDetected) {");
    const rankIndex = fn.indexOf("rankPartnerCandidates(allPartners, { category, limit })");
    expect(broadGuardIndex).toBeGreaterThan(-1);
    expect(narrowGuardIndex).toBeGreaterThan(broadGuardIndex);
    expect(rankIndex).toBeGreaterThan(narrowGuardIndex);
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

/**
 * Regression guards for the "spa disabled + no matching-category partner"
 * bug: a message like "je voudrais réserver un soin au spa demain" used to
 * make the model offer/collect a request against a totally unrelated
 * partner (e.g. a restaurant) just because it happened to be the only
 * active one — see rankPartnerCandidates's own fix (partners.ts) and
 * buildPartnerRequestGuidance's own fix (prompt.ts). This describe block
 * covers the answer.ts WIRING that feeds those two fixed functions: a
 * category-scoped, never-cross-category-fallback list for a BRAND NEW
 * request, kept entirely separate from the broad, unfiltered list still
 * used to validate an id once the model returns one.
 */
describe("answerQuestion — partnerRequestEligiblePartners (what a NEW request may target)", () => {
  it("[separate variable from allPartners] never reuses the same identifier for both the id-validation list and the offer-eligible list", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    expect(fn).toMatch(/let partnerRequestEligiblePartners: RagPartner\[\] = \[\];/);
    expect(fn).toMatch(/partnerRequestEligiblePartners = allPartners;/); // default: unfiltered, same as today for a category-agnostic message
  });

  it("[CASE A — category detected, zero matches] narrowed to the detected category, with NO cross-category fallback — a restaurant must never become eligible for a spa/wellness request", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    const narrowIndex = fn.indexOf("if (category && activePartnerRequest === null) {");
    expect(narrowIndex).toBeGreaterThan(-1);
    const narrowBlock = fn.slice(narrowIndex, fn.indexOf("}", narrowIndex) + 1);
    expect(narrowBlock).toMatch(/allPartners\.filter\(\(partner\) => partner\.category === category\)/);
    expect(narrowBlock).not.toMatch(/active\b/); // never falls back to "every active partner" — that logic was the bug
  });

  it("[CASE A — uncapped] the category-scoped list is never sliced by DEFAULT_PARTNER_LIMIT/ALL_PARTNERS_LIMIT — every real match must remain offerable, not just the first few", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    const narrowIndex = fn.indexOf("if (category && activePartnerRequest === null) {");
    const narrowBlock = fn.slice(narrowIndex, fn.indexOf("}", narrowIndex) + 1);
    expect(narrowBlock).not.toMatch(/DEFAULT_PARTNER_LIMIT|ALL_PARTNERS_LIMIT|rankPartnerCandidates/);
  });

  it("[CASE B — an active in-progress request is never narrowed] activePartnerRequest !== null skips the category narrowing entirely, preserving an already-valid target regardless of this turn's own category guess", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    expect(fn).toMatch(/if \(category && activePartnerRequest === null\) \{/);
  });

  it("[validation list untouched] allPartners — not partnerRequestEligiblePartners — is still what's passed to applyPartnerRequestFlow (id validation in processPartnerRequestTurn), in both branches", () => {
    const groundedFn = sliceFn("answerGrounded", "async function answerNoContext");
    const noContextFn = sliceFn("answerNoContext", "async function loadHistory");
    for (const fn of [groundedFn, noContextFn]) {
      const flowCallStart = fn.indexOf("await applyPartnerRequestFlow(reply, {");
      const flowCallEnd = fn.indexOf("});", flowCallStart);
      const flowCall = fn.slice(flowCallStart, flowCallEnd);
      expect(flowCall).toMatch(/\ballPartners,/);
      expect(flowCall).not.toMatch(/partnerRequestEligiblePartners/);
    }
  });

  it("[display/offer list uses the narrowed variable] both branches pass partnerRequestEligiblePartners — never allPartners — as allActivePartnersForRequest to buildHotelInstructions", () => {
    const groundedFn = sliceFn("answerGrounded", "async function answerNoContext");
    const noContextFn = sliceFn("answerNoContext", "async function loadHistory");
    for (const fn of [groundedFn, noContextFn]) {
      expect(fn).toMatch(/allActivePartnersForRequest: partnerRequestEligiblePartners,/);
    }
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

/**
 * request_phone_e164 (0020_partner_requests.sql / features/partners) is an
 * operational, private WhatsApp-routing number — it must never reach the
 * chatbot's own read path, the model, or the widget. This is a permanent
 * regression guard, not a one-off check: loadActiveHotelPartners
 * (features/rag/partners.ts) uses an explicit, minimal column list
 * (RAG_PARTNER_COLUMNS) that structurally EXCLUDES this column — it is no
 * longer even physically present on the JS objects the chatbot code holds
 * (previously true when that query used `select("*")`). This test still
 * checks for actual property access (`.request_phone_e164`), not a bare
 * word match, since the surrounding files' own doc comments legitimately
 * name the column in prose to explain the exclusion.
 */
describe("request_phone_e164 never reaches the chatbot/LLM/widget", () => {
  const promptSource = readFileSync(join(here, "prompt.ts"), "utf8");
  const partnersSource = readFileSync(join(here, "partners.ts"), "utf8");

  it("[answer.ts never references it]", () => {
    expect(source).not.toMatch(/request_phone_e164/);
  });

  it("[prompt.ts never references it] — the model-facing PARTENAIRES LOCAUX guidance only ever lists id/name/category/description/opening_hours", () => {
    expect(promptSource).not.toMatch(/request_phone_e164/);
  });

  it("[partners.ts never reads/selects it] — neither loadActiveHotelPartners, toPartnerRecommendation, nor buildPartnerAction access this field, and the explicit column list never names it", () => {
    expect(partnersSource).not.toMatch(/\.request_phone_e164/);
    expect(partnersSource).not.toMatch(/RAG_PARTNER_COLUMNS\s*=\s*"[^"]*request_phone_e164/);
  });

  it("[RagPartner type itself never declares it] the pipeline's own minimal type structurally cannot carry this field", () => {
    const typesSource = readFileSync(join(here, "types.ts"), "utf8");
    const ragPartnerBlock = typesSource.slice(typesSource.indexOf("export interface RagPartner"), typesSource.indexOf("export interface Chunk"));
    expect(ragPartnerBlock).not.toMatch(/request_phone_e164/);
  });

  it("[toPartnerRecommendation never forwards it] the widget-facing PartnerRecommendation shape is built from an explicit field list, never a spread of the raw HotelPartner row", () => {
    const fn = partnersSource.slice(partnersSource.indexOf("export function toPartnerRecommendation"));
    expect(fn).not.toMatch(/\.\.\.partner/);
  });
});

/**
 * whatsapp_consent_status/whatsapp_consent_requested_at/whatsapp_consent_responded_at/
 * whatsapp_consent_token_hash (0022_partner_transactional_consent.sql) govern
 * a SEPARATE, transactional WhatsApp consent — fully independent from the
 * chatbot-recommendation consent_status this pipeline already gates on (see
 * "hotel_partners never pollutes accommodation/RAG logic" above). None of
 * these four columns has any reason to exist inside the chatbot/RAG
 * pipeline at all — this is a permanent regression guard, mirroring the
 * request_phone_e164 guard above exactly.
 */
describe("whatsapp_consent_* (transactional WhatsApp consent) never reaches the chatbot/LLM/widget", () => {
  const promptSource = readFileSync(join(here, "prompt.ts"), "utf8");
  const partnersSource = readFileSync(join(here, "partners.ts"), "utf8");

  it("[answer.ts never references it]", () => {
    expect(source).not.toMatch(/whatsapp_consent/);
  });

  it("[prompt.ts never references it]", () => {
    expect(promptSource).not.toMatch(/whatsapp_consent/);
  });

  it("[partners.ts never reads/selects it] — neither loadActiveHotelPartners, toPartnerRecommendation, nor buildPartnerAction access these fields, and the explicit column list never names any of them", () => {
    expect(partnersSource).not.toMatch(/whatsapp_consent/);
  });

  it("[RagPartner type itself never declares any of the four columns] the pipeline's own minimal type structurally cannot carry this data", () => {
    const typesSource = readFileSync(join(here, "types.ts"), "utf8");
    const ragPartnerBlock = typesSource.slice(typesSource.indexOf("export interface RagPartner"), typesSource.indexOf("export interface Chunk"));
    expect(ragPartnerBlock).not.toMatch(/whatsapp_consent/);
  });

  it("[toPartnerRecommendation never forwards it] the widget-facing PartnerRecommendation shape never carries any whatsapp_consent_* field", () => {
    const fn = partnersSource.slice(partnersSource.indexOf("export function toPartnerRecommendation"));
    expect(fn).not.toMatch(/whatsapp_consent/);
  });
});
