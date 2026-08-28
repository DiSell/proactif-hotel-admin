import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Regression guards for the chatbot -> partner_requests integration —
 * answerQuestion() can't be unit-tested directly (needs Supabase + OpenAI,
 * see answer.groundingMode.test.ts's own comment for the same constraint),
 * so these check the source-level shape, same convention as
 * answer.partners.test.ts. The orchestration logic itself
 * (processPartnerRequestTurn) IS unit-tested with real invocation in
 * partnerRequestFlow.test.ts, since that module takes no Next.js-specific
 * dependency and is fully mockable.
 */
function sliceFn(name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}`) !== -1 ? source.indexOf(`async function ${name}`) : source.indexOf(`function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(nextName, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

describe("answerQuestion — phone redaction runs before persistence and before the model ever sees the message", () => {
  it("[redacted immediately] redactPhoneNumbers is called on the raw param, before the hotel/settings fetch or the messages insert", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    const redactIndex = fn.indexOf("redactPhoneNumbers(rawMessage)");
    const insertIndex = fn.indexOf('.insert({ hotel_id: hotelId, conversation_id: conversationId, role: "user", content: message })');
    expect(redactIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(redactIndex);
  });

  it("[persisted content is the sanitized text] the insert uses `message` (post-redaction), never `rawMessage`", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    expect(fn).toMatch(/content: message \}\)/);
    expect(fn).not.toMatch(/content: rawMessage/);
  });

  it("[raw param is renamed] the destructured parameter is `message: rawMessage`, not bound directly to `message` — impossible to accidentally use the raw value under the `message` name", () => {
    expect(source).toMatch(/message: rawMessage,/);
  });
});

describe("answerQuestion — active partner_request lookup and gating", () => {
  it("[checked every turn, not gated by partnerIntentDetected] getActivePartnerRequestForConversation runs unconditionally — a bare confirmation reply must still be caught", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    const detectIndex = fn.indexOf("const partnerIntentDetected = isPartnerIntent(message);");
    const activeIndex = fn.indexOf("await getActivePartnerRequestForConversation(hotelId, conversationId, supabase)");
    const ifGuardIndex = fn.indexOf("if (partnerIntentDetected) {");
    expect(detectIndex).toBeGreaterThan(-1);
    expect(activeIndex).toBeGreaterThan(-1);
    // Not nested inside the narrow partnerIntentDetected guard — the whole
    // point is it must run even when partnerIntentDetected is false.
    expect(activeIndex).toBeLessThan(ifGuardIndex);
  });

  it("[broader gate] partnerRequestFlowActive is partnerIntentDetected OR an active request exists", () => {
    const fn = sliceFn("answerQuestion", "type HistoryInputItem");
    expect(fn).toMatch(/const partnerRequestFlowActive = partnerIntentDetected \|\| activePartnerRequest !== null;/);
  });

  it("[threaded to both branches] both answerGrounded and answerNoContext receive normalizedPhoneE164, activePartnerRequest, partnerRequestFlowActive, allPartners", () => {
    const answerQuestionFn = sliceFn("answerQuestion", "type HistoryInputItem");
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    const groundedCall = answerQuestionFn.slice(groundedCallStart, groundedCallEnd);
    for (const field of ["normalizedPhoneE164,", "activePartnerRequest,", "partnerRequestFlowActive,", "allPartners,"]) {
      expect(groundedCall).toContain(field);
    }

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    const noContextCall = answerQuestionFn.slice(noContextCallStart, noContextCallEnd);
    for (const field of ["normalizedPhoneE164,", "activePartnerRequest,", "partnerRequestFlowActive,", "allPartners,"]) {
      expect(noContextCall).toContain(field);
    }
  });
});

describe("structured output schemas — minimal partner-request extension, shared by both branches", () => {
  it("[shared field set] partnerRequestOutputFields is spread into BOTH groundedReplySchema and noContextReplySchema", () => {
    expect(source).toMatch(/const groundedReplySchema = z\.object\(\{[\s\S]*?\.\.\.partnerRequestOutputFields,[\s\S]*?\}\);/);
    expect(source).toMatch(/const noContextReplySchema = z\.object\(\{[\s\S]*?\.\.\.partnerRequestOutputFields,[\s\S]*?\}\);/);
  });

  it("[exact field list] matches the spec — no target status, no event_type, no phone field", () => {
    const fieldsBlock = source.slice(
      source.indexOf("const partnerRequestOutputFields"),
      source.indexOf("};", source.indexOf("const partnerRequestOutputFields"))
    );
    for (const field of [
      "partnerRequestIntent",
      "partnerId",
      "requestedDate",
      "requestedTime",
      "partySize",
      "details",
      "guestName",
      "needsGuestName",
      "needsGuestPhone",
      "confirmPartnerRequest",
    ]) {
      expect(fieldsBlock).toContain(field);
    }
    expect(fieldsBlock).not.toMatch(/guest_phone_e164|guestPhoneE164|request_phone_e164|status|eventType|event_type/i);
  });
});

describe("answerGrounded / answerNoContext — partner request wiring", () => {
  it("[grounded] applyPartnerRequestFlow is called with the model's own output_parsed, gated by partnerRequestFlowActive, and both `reply`/`partnerRequestPhonePrompt` are taken from its result", () => {
    const fn = sliceFn("answerGrounded", "async function answerNoContext");
    expect(fn).toMatch(/if \(partnerRequestFlowActive\) \{/);
    expect(fn).toMatch(/const flowResult = await applyPartnerRequestFlow\(reply, \{/);
    expect(fn).toMatch(/reply = flowResult\.reply;/);
    expect(fn).toMatch(/partnerRequestPhonePrompt = flowResult\.partnerRequestPhonePrompt;/);
    expect(fn).toMatch(/modelOutput: response\.output_parsed,/);
  });

  it("[no_context] same wiring, independent of groundingMode", () => {
    const fn = sliceFn("answerNoContext", "async function loadHistory");
    expect(fn).toMatch(/if \(partnerRequestFlowActive\) \{/);
    expect(fn).toMatch(/const flowResult = await applyPartnerRequestFlow\(reply, \{/);
    expect(fn).toMatch(/reply = flowResult\.reply;/);
  });

  it("[persisted AFTER the recap is appended] insertAssistantMessage's content is the (possibly recap-appended) `reply`, in both branches", () => {
    const groundedFn = sliceFn("answerGrounded", "async function answerNoContext");
    const noContextFn = sliceFn("answerNoContext", "async function loadHistory");
    for (const fn of [groundedFn, noContextFn]) {
      const flowIndex = fn.indexOf("const flowResult = await applyPartnerRequestFlow(reply, {");
      const persistIndex = fn.indexOf("insertAssistantMessage(supabase, {");
      expect(flowIndex).toBeGreaterThan(-1);
      expect(persistIndex).toBeGreaterThan(flowIndex);
    }
  });

  it("[partnerRequestPhonePrompt threaded into the final result] both branches return it alongside reply", () => {
    const groundedFn = sliceFn("answerGrounded", "async function answerNoContext");
    const noContextFn = sliceFn("answerNoContext", "async function loadHistory");
    expect(groundedFn).toMatch(/partnerRequestPhonePrompt \};/);
    expect(noContextFn).toMatch(/partnerRequestPhonePrompt \};/);
  });
});

describe("applyPartnerRequestFlow — best-effort, never fails the whole turn, never mislabeled as an OpenAI error", () => {
  it("[own try/catch, swallows and logs] a partner-request failure never throws out of this function", () => {
    const fn = sliceFn("applyPartnerRequestFlow", "function buildPartnerRecommendations");
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/catch \(err\) \{/);
    expect(fn).toMatch(/console\.error\("answerQuestion: partner request flow failed"/);
    expect(fn).toMatch(/return \{ reply, partnerRequestPhonePrompt: null \};/); // the catch branch returns the ORIGINAL reply unchanged, never throws
  });

  it("[never logs guest_phone_e164 or the raw message]", () => {
    const fn = sliceFn("applyPartnerRequestFlow", "function buildPartnerRecommendations");
    const logCalls = fn.match(/console\.error\([^)]*\)/g) ?? [];
    for (const call of logCalls) {
      expect(call).not.toMatch(/normalizedPhoneE164/);
      expect(call).not.toMatch(/params\.message/);
    }
  });

  it("[DB status wins] post-confirmation outcomes replace model prose; ordinary recaps are still appended", () => {
    const fn = sliceFn("applyPartnerRequestFlow", "function buildPartnerRecommendations");
    expect(fn).toMatch(/outcome\.replaceReply \? outcome\.replySuffix/);
    expect(fn).toMatch(/`\$\{reply\}\\n\\n\$\{outcome\.replySuffix\}`/);
  });
});

describe("no delivery command anywhere in answer.ts itself", () => {
  // partnerRequestFlow.ts/chatbotService.ts legitimately DISCUSS
  // partner_delivery_succeeded/partner_delivery_failed/WhatsApp in doc
  // comments explaining why they're deliberately never called — a bare text
  // scan on those files would false-positive on that prose. The real,
  // reliable guarantees are: the TYPE-level restriction in
  // chatbotService.ts (see chatbotService.test.ts's own
  // "[structurally cannot call a delivery command]" test) and the actual
  // mock-call assertions in partnerRequestFlow.test.ts's
  // "[no delivery command ever called]" test. answer.ts itself has no
  // legitimate reason to mention any of this at all, so a plain scan is
  // safe here.
  it("[answer.ts never references a delivery command or WhatsApp/provider]", () => {
    expect(source).not.toMatch(/partner_delivery_succeeded|partner_delivery_failed/);
    expect(source).not.toMatch(/whatsapp/i);
    expect(source).not.toMatch(/twilio/i);
  });
});
