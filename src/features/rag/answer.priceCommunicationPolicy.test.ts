import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { containsUnauthorizedMonetaryAmount, PRICE_LOCKED_FALLBACK_REPLY } from "./pricePolicy";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Defense-in-depth price-communication policy — answerQuestion() can't be
 * unit-tested directly here (Supabase + OpenAI, no mocking infra in this
 * repo — same constraint as every other answer.ts test file), so this
 * checks the source-level wiring for the two layers that live in this file
 * (context redaction and the output-side lock — layer D lives in
 * prompt.ts, tested there; the detector/comparison itself is tested in
 * pricePolicy.test.ts with real invocation).
 *
 * Certified-source model (see pricePolicy.ts's own doc comment):
 * canCommunicatePrice = hotelAllowsPriceCommunication && priceIsCertified.
 * `allowPriceCommunication` alone (the hotel's own toggle) is NECESSARY but
 * never SUFFICIENT — `authorizedPriceAmounts` (built once in
 * answerQuestion, from hotel_spa_settings.price_per_person, the only
 * certified source today) is what the output-side lock actually compares
 * against, never the toggle alone.
 */
describe("answer.ts wiring — price-communication policy", () => {
  const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));

  it("[resolved once, up front] isPriceCommunicationAllowed(settings) is called exactly once, right after settings is fetched", () => {
    const occurrences = source.match(/isPriceCommunicationAllowed\(settings\)/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(answerQuestionFn).toMatch(/const allowPriceCommunication = isPriceCommunicationAllowed\(settings\);/);

    const settingsFetchIndex = answerQuestionFn.indexOf('.from("chatbot_settings")');
    const allowIndex = answerQuestionFn.indexOf("const allowPriceCommunication = isPriceCommunicationAllowed(settings);");
    expect(settingsFetchIndex).toBeGreaterThan(-1);
    expect(settingsFetchIndex).toBeLessThan(allowIndex);
  });

  it("[layer B — context redaction] applied to the FINAL merged relevantChunks (after the Option-2 scoped merge), inside the same try block, BEFORE groundingMode is computed", () => {
    const mergeCallIndex = answerQuestionFn.indexOf("relevantChunks = mergeGuaranteedChunks(relevantChunks, scopedChunks);");
    const redactIndex = answerQuestionFn.indexOf("relevantChunks = relevantChunks.map((chunk) => ({ ...chunk, content: redactMonetaryAmounts(chunk.content) }));");
    const groundingModeIndex = answerQuestionFn.indexOf('const groundingMode: GroundingMode = relevantChunks.length > 0 ? "grounded" : "no_context";');
    expect(mergeCallIndex).toBeGreaterThan(-1);
    expect(redactIndex).toBeGreaterThan(-1);
    expect(groundingModeIndex).toBeGreaterThan(-1);
    expect(mergeCallIndex).toBeLessThan(redactIndex);
    expect(redactIndex).toBeLessThan(groundingModeIndex);
  });

  it("[layer B is now UNCONDITIONAL — the hotel toggle no longer controls RAG redaction] RAG text is never a certified source regardless of allow_price_communication, so this runs every turn, not gated behind an `if`", () => {
    // The redaction line is a bare statement, never behind an `if (allowPriceCommunication...)`-shaped guard immediately before it.
    const redactIndex = answerQuestionFn.indexOf("relevantChunks = relevantChunks.map((chunk) => ({ ...chunk, content: redactMonetaryAmounts(chunk.content) }));");
    const precedingLines = answerQuestionFn.slice(Math.max(0, redactIndex - 200), redactIndex);
    expect(precedingLines).not.toMatch(/if \([^)]*allowPriceCommunication[^)]*\)\s*\{\s*$/);
  });

  it("[layer B never drops a whole chunk] maps content in place, keeps every chunk's other fields (chunkId, sourceTitle, etc.) untouched", () => {
    expect(answerQuestionFn).toMatch(/relevantChunks\.map\(\(chunk\) => \(\{ \.\.\.chunk, content: redactMonetaryAmounts\(chunk\.content\) \}\)\)/);
  });

  it("[authorizedPriceAmounts computed once, mirroring buildSpaAvailabilityGuidance's own three conditions exactly] allowPriceCommunication && spaBookingFlowActive && spaAvailability.pricePerPerson !== null", () => {
    expect(answerQuestionFn).toMatch(
      /const authorizedPriceAmounts: number\[\] =\s*\n\s*allowPriceCommunication && spaBookingFlowActive && spaAvailability\.pricePerPerson !== null \? \[spaAvailability\.pricePerPerson\] : \[\];/
    );
  });

  it("[threaded through both branches] allowPriceCommunication AND authorizedPriceAmounts are passed to both answerGrounded and answerNoContext, and allowPriceCommunication into both buildHotelInstructions calls", () => {
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/allowPriceCommunication,/);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/authorizedPriceAmounts,/);

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/allowPriceCommunication,/);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/authorizedPriceAmounts,/);

    function sliceFn(name: string, nextName: string): string {
      const start = source.indexOf(`async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf(nextName, start);
      return end === -1 ? source.slice(start) : source.slice(start, end);
    }
    for (const fn of [sliceFn("answerGrounded", "async function answerNoContext"), sliceFn("answerNoContext", "async function loadHistory")]) {
      const instructionsCallStart = fn.indexOf("buildHotelInstructions({");
      const instructionsCallEnd = fn.indexOf("});", instructionsCallStart);
      expect(fn.slice(instructionsCallStart, instructionsCallEnd)).toMatch(/allowPriceCommunication,/);
    }
  });

  it("[layer C — output lock present in BOTH branches, comparing against authorizedPriceAmounts, never a bare boolean] applied to the FINAL reply, after partner/spa flow suffixes, BEFORE the booking/room-discovery markers", () => {
    function sliceFn(name: string, nextName: string): string {
      const start = source.indexOf(`async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf(nextName, start);
      return end === -1 ? source.slice(start) : source.slice(start, end);
    }

    for (const fn of [sliceFn("answerGrounded", "async function answerNoContext"), sliceFn("answerNoContext", "async function loadHistory")]) {
      const spaBranchIndex = fn.indexOf("spaBookingPhonePrompt = flowResult.spaBookingPhonePrompt;");
      const lockIndex = fn.indexOf("if (containsUnauthorizedMonetaryAmount(reply, authorizedPriceAmounts)) {");
      const bookingMarkerIndex = fn.indexOf("if (bookingIntentDetected) {");
      const roomDiscoveryMarkerIndex = fn.indexOf("if (roomDiscoveryIntentDetected) {");
      expect(spaBranchIndex).toBeGreaterThan(-1);
      expect(lockIndex).toBeGreaterThan(-1);
      expect(spaBranchIndex).toBeLessThan(lockIndex);
      expect(lockIndex).toBeLessThan(bookingMarkerIndex);
      expect(lockIndex).toBeLessThan(roomDiscoveryMarkerIndex);
    }
  });

  it("[layer C is a FULL replacement, never a partial redaction] uses the fixed fallback constant, never redactMonetaryAmounts on the reply itself", () => {
    function sliceFn(name: string, nextName: string): string {
      const start = source.indexOf(`async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf(nextName, start);
      return end === -1 ? source.slice(start) : source.slice(start, end);
    }
    for (const fn of [sliceFn("answerGrounded", "async function answerNoContext"), sliceFn("answerNoContext", "async function loadHistory")]) {
      expect(fn).toMatch(/reply = PRICE_LOCKED_FALLBACK_REPLY;/);
      expect(fn).not.toMatch(/reply = redactMonetaryAmounts\(reply\)/);
    }
  });

  it("[still inside the try block, still before the catch — same discipline as the booking/room-discovery markers]", () => {
    function sliceFn(name: string, nextName: string): string {
      const start = source.indexOf(`async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf(nextName, start);
      return end === -1 ? source.slice(start) : source.slice(start, end);
    }
    for (const fn of [sliceFn("answerGrounded", "async function answerNoContext"), sliceFn("answerNoContext", "async function loadHistory")]) {
      const lockIndex = fn.indexOf("if (containsUnauthorizedMonetaryAmount(reply, authorizedPriceAmounts)) {");
      const catchIndex = fn.indexOf("} catch (err) {");
      expect(lockIndex).toBeLessThan(catchIndex);
    }
  });
});

/**
 * Multi-turn PRICE OFF — a real, previously-open question (not empirically
 * tested live, since fabricating an old price in a real conversation's
 * history would require a production DB write). Answered here
 * deterministically instead: `historyInput` is plain data answerQuestion
 * already threads through unmodified into `input` — nothing filters or
 * redacts it on the way in, so an old price CAN sit there. That is exactly
 * why the guarantee must live on OUTPUT (layer C), never rely on history
 * being "clean": the lock inspects the CURRENT turn's own `reply` only,
 * completely independent of why that reply contains a monetary amount.
 * Chains the exact real, exported function the lock itself calls
 * (containsUnauthorizedMonetaryAmount), never a mock of the policy itself.
 */
describe("multi-turn PRICE OFF — an old price sitting in historyInput is never re-surfaced", () => {
  /** The EXACT lock expression from answer.ts's own two call sites — reproduced, not reimplemented differently. */
  function applyOutputLock(reply: string, authorizedAmounts: number[]): string {
    return containsUnauthorizedMonetaryAmount(reply, authorizedAmounts) ? PRICE_LOCKED_FALLBACK_REPLY : reply;
  }

  it("[the old price CAN exist in history — nothing filters historyInput itself] a stale assistant message stating a price is ordinary data, not something answer.ts scrubs retroactively", () => {
    const historyInput = [
      { role: "user" as const, content: "combien coûte la Deluxe ?" },
      { role: "assistant" as const, content: "La Deluxe est proposée à 288 €." },
    ];
    expect(historyInput[1].content).toContain("288 €");
    expect(containsUnauthorizedMonetaryAmount(historyInput[1].content, [])).toBe(true);
  });

  it("[the danger case, OFF] if the model's CURRENT reply echoes/reuses that old price ('comme mentionné, 288 €'), the lock replaces it — provenance never matters", () => {
    const modelReplyThatEchoesHistory = "Comme indiqué précédemment, la Deluxe reste à 288 € la nuit.";
    const locked = applyOutputLock(modelReplyThatEchoesHistory, []);
    expect(locked).toBe(PRICE_LOCKED_FALLBACK_REPLY);
  });

  it("[every subsequent turn is independently protected, OFF] simulating 3 further turns after the old price entered history, each one's own reply is still locked regardless of how many turns have passed", () => {
    const historyInput = [
      { role: "user" as const, content: "combien coûte la Deluxe ?" },
      { role: "assistant" as const, content: "La Deluxe est proposée à 288 €." },
      { role: "user" as const, content: "et la Standard ?" },
      { role: "assistant" as const, content: applyOutputLock("La Standard est à 218 €.", []) },
      { role: "user" as const, content: "et la Mini-suite alors ?" },
    ];
    expect(historyInput[3].content).toBe(PRICE_LOCKED_FALLBACK_REPLY);

    const turn3Reply = applyOutputLock("Pour la Mini-suite, comptez environ 190 € comme pour la Deluxe à 288 € mentionnée plus haut.", []);
    expect(turn3Reply).toBe(PRICE_LOCKED_FALLBACK_REPLY);
  });

  it("[non-price replies are never touched, even with an old price sitting right next to them in history]", () => {
    const currentReply = "La Deluxe fait 45 m² et dispose de la climatisation réversible.";
    expect(applyOutputLock(currentReply, [])).toBe(currentReply);
  });

  it("[ON, but still no certified amount this turn — the RAG price is STILL blocked] documents the CORRECTED boundary: allow_price_communication=true never means 'RAG amounts become OK' — only membership in authorizedPriceAmounts does, and an echoed RAG price is never in it", () => {
    const modelReplyThatEchoesHistory = "Comme indiqué précédemment, la Deluxe reste à 288 € la nuit.";
    // ON, but this turn has no spa price certified (e.g. a room-price question) -> authorizedAmounts is empty -> still locked:
    expect(applyOutputLock(modelReplyThatEchoesHistory, [])).toBe(PRICE_LOCKED_FALLBACK_REPLY);
  });

  it("[ON + genuinely certified amount this turn] the SAME echoed text would only pass if 288 were itself the certified amount — proving the mechanism checks the VALUE, not just 'ON'", () => {
    const modelReplyThatEchoesHistory = "Comme indiqué précédemment, la Deluxe reste à 288 € la nuit.";
    expect(applyOutputLock(modelReplyThatEchoesHistory, [288])).toBe(modelReplyThatEchoesHistory);
    // But a DIFFERENT uncertified amount in the same kind of reply is still blocked even with 288 authorized:
    expect(applyOutputLock("La Deluxe est à 300 € la nuit.", [288])).toBe(PRICE_LOCKED_FALLBACK_REPLY);
  });
});

/**
 * CAS CRITIQUE — explicitly required: a genuinely certified amount (spa,
 * 50 €) and an uncertified one (RAG, 288 €) appearing in the SAME reply.
 * The whole reply is rejected, never partially trimmed down to the
 * certified part alone (see PRICE_LOCKED_FALLBACK_REPLY's own doc comment
 * on why a full replacement is deliberate) — "50 € peut sortir, 288 € ne
 * peut pas" is achieved by never letting EITHER through when they're mixed
 * in one reply, not by surgically keeping one and cutting the other.
 */
describe("CAS CRITIQUE — certified SPA amount mixed with an uncertified RAG amount in the same reply", () => {
  function applyOutputLock(reply: string, authorizedAmounts: number[]): string {
    return containsUnauthorizedMonetaryAmount(reply, authorizedAmounts) ? PRICE_LOCKED_FALLBACK_REPLY : reply;
  }

  it("[ON + SPA certified 50 € alone] passes through unchanged", () => {
    const reply = "L'accès au spa coûte 50 € par personne.";
    expect(applyOutputLock(reply, [50])).toBe(reply);
  });

  it("[ON + SPA certified 50 € + RAG 288 € in the same reply] the whole reply is rejected — 288 € never leaks out, and 50 € doesn't survive as a partial answer either", () => {
    const reply = "L'accès au spa coûte 50 € par personne, et la Deluxe est à 288 € la nuit.";
    const result = applyOutputLock(reply, [50]);
    expect(result).toBe(PRICE_LOCKED_FALLBACK_REPLY);
    expect(result).not.toContain("288");
    expect(result).not.toContain("50");
  });

  it("[ON + SPA certified 50 € + model produces 60 €] a near-miss/hallucinated amount is rejected just as surely as an unrelated one", () => {
    const reply = "L'accès au spa coûte 60 € par personne.";
    expect(applyOutputLock(reply, [50])).toBe(PRICE_LOCKED_FALLBACK_REPLY);
  });

  it("[format-insensitive matching] 50, 50,00 €, and 50.00 EUR are all recognized as the SAME certified amount", () => {
    expect(applyOutputLock("Le spa coûte 50 €.", [50])).toBe("Le spa coûte 50 €.");
    expect(applyOutputLock("Le spa coûte 50,00 €.", [50])).toBe("Le spa coûte 50,00 €.");
    expect(applyOutputLock("Le spa coûte 50.00 EUR.", [50])).toBe("Le spa coûte 50.00 EUR.");
  });
});
