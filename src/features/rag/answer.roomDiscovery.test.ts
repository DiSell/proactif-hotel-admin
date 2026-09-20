import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isBookingIntent, buildBookingAction } from "./answer";
import { lastAssistantMessageIndicatesBookingIntent, withBookingIntentMarker } from "./bookingIntentContinuation";
import { lastAssistantMessageIndicatesRoomDiscoveryContinuation, withRoomDiscoveryMarker } from "./roomDiscoveryContinuation";
import { isRoomDiscoveryIntent, mentionsKnownAccommodationName } from "./accommodationRanking";
import { extractPartySize, extractPartySizeFromHistory, isPartyKnown, mergeValidatedStayRequestIntoParty } from "./partySize";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

const HOST_WIDGET_HOTEL = {
  booking_action_mode: "host_widget" as const,
  booking_url: null,
  host_booking_trigger: { strategy: "click" as const, selector: "#resa-toggle-menu" },
};

type HistoryItem = { role: "user" | "assistant"; content: string };

/**
 * Mirrors answer.ts's own EXACT combined-signal computation for one turn —
 * answerQuestion() can't be invoked directly here (Supabase + OpenAI, no
 * mocking infra in this repo), so these tests chain the exact same pure,
 * exported functions answer.ts itself calls, in the same order, to
 * genuinely exercise the precedence/continuation logic rather than
 * asserting on source text alone.
 */
function computeSignalsForTurn(message: string, history: HistoryItem[]) {
  const roomDiscoveryContinuationSignal = lastAssistantMessageIndicatesRoomDiscoveryContinuation(history);
  const roomDiscoveryIntentDetected = isRoomDiscoveryIntent(message) || (roomDiscoveryContinuationSignal && !isBookingIntent(message));
  const bookingIntentDetected = !roomDiscoveryIntentDetected && (isBookingIntent(message) || lastAssistantMessageIndicatesBookingIntent(history));
  return { roomDiscoveryContinuationSignal, roomDiscoveryIntentDetected, bookingIntentDetected };
}

/** Applies whichever marker(s) the real answerGrounded/answerNoContext would apply to this turn's reply, in the same order. */
function markReply(reply: string, signals: ReturnType<typeof computeSignalsForTurn>): string {
  let marked = reply;
  if (signals.bookingIntentDetected) marked = withBookingIntentMarker(marked);
  if (signals.roomDiscoveryIntentDetected) marked = withRoomDiscoveryMarker(marked);
  return marked;
}

describe("ROOM_DISCOVERY — [A] 'montre moi les chambres' -> '2' -> compatible categories", () => {
  it("[T1] intent detected, party unknown, reply marked for continuation", () => {
    const t1 = computeSignalsForTurn("montre moi les chambres", []);
    expect(t1.roomDiscoveryIntentDetected).toBe(true);
    expect(isPartyKnown(extractPartySize("montre moi les chambres"))).toBe(false);
  });

  it("[T2] a bare '2' is recognized as continuing the flow — the gate that WOULD trigger resolveStayRequestFromHistory reopens", () => {
    const t1Reply = markReply("Bien sûr. Pour combien de personnes ?", computeSignalsForTurn("montre moi les chambres", []));
    const historyBeforeT2: HistoryItem[] = [
      { role: "user", content: "montre moi les chambres" },
      { role: "assistant", content: t1Reply },
    ];
    // Without continuation, "2" alone would fall through every gate (the
    // confirmed root cause of the original stress-test failure):
    expect(isRoomDiscoveryIntent("2")).toBe(false);
    expect(isPartyKnown(extractPartySize("2"))).toBe(false);

    const t2 = computeSignalsForTurn("2", historyBeforeT2);
    expect(t2.roomDiscoveryContinuationSignal).toBe(true);
    expect(t2.roomDiscoveryIntentDetected).toBe(true); // the gate reopens via continuation, not via any new keyword match
    expect(t2.bookingIntentDetected).toBe(false);
  });

  it("[T2, resolution — no longer depends on the LLM at all] a bare '2' on its own is NOT deterministically parseable (no 'personnes' keyword) — this specific reply genuinely still needs resolveStayRequestFromHistory; see [B] below for the case the deterministic fix now fully resolves on its own", () => {
    expect(isPartyKnown(extractPartySize("2"))).toBe(false);
    // Once resolveStayRequestFromHistory DOES resolve it (adults=2, childrenCount
    // null — its own real, previously-observed behavior for this phrasing shape),
    // the party-merge fix still makes it usable immediately:
    const merged = mergeValidatedStayRequestIntoParty({ adults: null, children: null, total: null }, { adults: 2, childrenCount: null });
    expect(isPartyKnown(merged)).toBe(true);
    expect(merged.total).toBe(2);
  });
});

describe("ROOM_DISCOVERY — [B] 'nous sommes 2' -> 'montre moi les chambres' : reuses party from history, never re-asks", () => {
  it("[T2] fresh discovery intent fires the SAME resolution gate regardless of continuation — full history (including 'nous sommes 2') is what resolveStayRequestFromHistory reads", () => {
    const t1 = computeSignalsForTurn("nous sommes 2", []);
    expect(t1.roomDiscoveryIntentDetected).toBe(false); // "nous sommes 2" alone isn't a discovery message
    expect(isPartyKnown(extractPartySize("nous sommes 2"))).toBe(true); // but party IS already known from this turn alone

    const historyBeforeT2: HistoryItem[] = [
      { role: "user", content: "nous sommes 2" },
      { role: "assistant", content: "Très bien, que puis-je faire pour vous ?" },
    ];
    const t2 = computeSignalsForTurn("montre moi les chambres", historyBeforeT2);
    expect(t2.roomDiscoveryIntentDetected).toBe(true); // fresh match, independent of continuation this time
  });

  it("[T2, resolution — now 100% deterministic, no OpenAI call needed at all] extractPartySizeFromHistory alone recovers 'nous sommes 2' from T1, before resolveStayRequestFromHistory is ever reached — this is the actual fix for the measured 2/4 non-determinism", () => {
    const historyBeforeT2: HistoryItem[] = [
      { role: "user", content: "nous sommes 2" },
      { role: "assistant", content: "Très bien, que puis-je faire pour vous ?" },
    ];
    const fromHistory = extractPartySizeFromHistory(historyBeforeT2);
    expect(fromHistory).toEqual({ adults: null, children: null, total: 2 });
    expect(isPartyKnown(fromHistory!)).toBe(true);
  });
});

describe("ROOM_DISCOVERY — [C] 'montre moi les chambres' -> '2' -> 'la Deluxe' : continuity through to a precise category", () => {
  it("[T3] 'la Deluxe' alone matches neither isRoomDiscoveryIntent nor a fresh booking intent — continuation is the ONLY thing keeping the gate (and the widened retrieval limit) open on this turn", () => {
    const t1Reply = markReply("Bien sûr. Pour combien de personnes ?", computeSignalsForTurn("montre moi les chambres", []));
    const historyAfterT1: HistoryItem[] = [
      { role: "user", content: "montre moi les chambres" },
      { role: "assistant", content: t1Reply },
    ];
    const t2Signals = computeSignalsForTurn("2", historyAfterT1);
    const partyAfterT2 = mergeValidatedStayRequestIntoParty({ adults: null, children: null, total: null }, { adults: 2, childrenCount: null });
    const t2Reply = markReply("Voici nos catégories pour 2 personnes : ...", t2Signals);
    const historyAfterT2: HistoryItem[] = [...historyAfterT1, { role: "user", content: "2" }, { role: "assistant", content: t2Reply }];

    expect(isRoomDiscoveryIntent("la Deluxe")).toBe(false);
    expect(isBookingIntent("la Deluxe")).toBe(false);

    const t3Signals = computeSignalsForTurn("la Deluxe", historyAfterT2);
    expect(t3Signals.roomDiscoveryContinuationSignal).toBe(true); // T2's reply was still marked
    expect(t3Signals.roomDiscoveryIntentDetected).toBe(true); // so the gate (retrieval widening + party re-resolution) stays open on T3 too
    expect(isPartyKnown(partyAfterT2)).toBe(true); // party carried forward — no re-ask on T3 either
  });

  it("[data-dependent step, out of scope for this fix] resolving 'la Deluxe' to a real accommodationTypeId still requires real accommodation_types rows for the hotel — Le 1837 has none today, so this last step remains RAG-text-only until that data is populated (separately, with explicit authorization)", () => {
    // Documents the boundary rather than fabricating a result: mentionsKnownAccommodationName
    // (the mechanism that WOULD resolve this once real data exists) is exercised in
    // accommodationRanking.test.ts; there is nothing further to assert here without inventing data.
    expect(mentionsKnownAccommodationName("la Deluxe", [])).toBe(false);
  });
});

describe("ROOM_DISCOVERY — [D] classic booking continuation is unaffected", () => {
  it("[T1->T2] 'je veux réserver' -> '20 au 22 septembre pour 2' : CTA persists", () => {
    const t1 = computeSignalsForTurn("je veux réserver", []);
    expect(t1.bookingIntentDetected).toBe(true);
    expect(buildBookingAction(t1.bookingIntentDetected, HOST_WIDGET_HOTEL)).toEqual({ type: "host_booking", label: "Réserver" });

    const t1Reply = markReply("Quelles sont vos dates ?", t1);
    const historyBeforeT2: HistoryItem[] = [
      { role: "user", content: "je veux réserver" },
      { role: "assistant", content: t1Reply },
    ];
    const t2 = computeSignalsForTurn("20 au 22 septembre pour 2", historyBeforeT2);
    expect(t2.roomDiscoveryIntentDetected).toBe(false);
    expect(t2.bookingIntentDetected).toBe(true);
    expect(buildBookingAction(t2.bookingIntentDetected, HOST_WIDGET_HOTEL)).toEqual({ type: "host_booking", label: "Réserver" });
  });
});

describe("ROOM_DISCOVERY — [E] 'je veux réserver' -> 'montre moi les chambres' : discovery takes over, no inherited CTA", () => {
  it("[T2] fresh discovery intent overrides the booking marker for this turn's CTA, without destroying booking (a later 'je veux réserver' still works — see bookingIntentContinuation's own precedence tests)", () => {
    const t1 = computeSignalsForTurn("je veux réserver", []);
    const t1Reply = markReply("Quelles sont vos dates ?", t1);
    const historyBeforeT2: HistoryItem[] = [
      { role: "user", content: "je veux réserver" },
      { role: "assistant", content: t1Reply },
    ];
    expect(lastAssistantMessageIndicatesBookingIntent(historyBeforeT2)).toBe(true); // marker genuinely present

    const t2 = computeSignalsForTurn("montre moi les chambres", historyBeforeT2);
    expect(t2.roomDiscoveryIntentDetected).toBe(true);
    expect(t2.bookingIntentDetected).toBe(false); // suppressed THIS turn despite the marker being present
    expect(buildBookingAction(t2.bookingIntentDetected, HOST_WIDGET_HOTEL)).toBeNull();
  });

  it("[T3] a LATER, fresh 'je veux réserver' still reactivates booking normally, even mid-discovery — continuation never permanently locks discovery in", () => {
    const t1 = computeSignalsForTurn("je veux réserver", []);
    const t1Reply = markReply("Quelles sont vos dates ?", t1);
    const t2 = computeSignalsForTurn("montre moi les chambres", [{ role: "user", content: "je veux réserver" }, { role: "assistant", content: t1Reply }]);
    const t2Reply = markReply("Pour combien de personnes ?", t2);
    const historyBeforeT3: HistoryItem[] = [
      { role: "user", content: "je veux réserver" },
      { role: "assistant", content: t1Reply },
      { role: "user", content: "montre moi les chambres" },
      { role: "assistant", content: t2Reply },
    ];
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation(historyBeforeT3)).toBe(true); // discovery marker genuinely still present

    const t3 = computeSignalsForTurn("je veux réserver", historyBeforeT3);
    expect(t3.roomDiscoveryIntentDetected).toBe(false); // fresh, explicit booking intent overrides the stale continuation
    expect(t3.bookingIntentDetected).toBe(true);
    expect(buildBookingAction(t3.bookingIntentDetected, HOST_WIDGET_HOTEL)).toEqual({ type: "host_booking", label: "Réserver" });
  });
});

describe("ROOM_DISCOVERY — [F] 'je veux voir la Junior Suite' : precise category, never gated behind a party question", () => {
  it("isRoomDiscoveryIntent is false — a named, qualified category is never treated as a catalogue request", () => {
    expect(isRoomDiscoveryIntent("je veux voir la Junior Suite")).toBe(false);
  });

  it("as a fresh turn (no continuation), roomDiscoveryIntentDetected stays false — falls straight through to plain RAG/grounded, no party question first", () => {
    const t1 = computeSignalsForTurn("je veux voir la Junior Suite", []);
    expect(t1.roomDiscoveryIntentDetected).toBe(false);
  });
});

describe("ROOM_DISCOVERY — [G] 'la Junior Suite fait combien de mètres carrés ?' : documentary, not catalogue", () => {
  it("isRoomDiscoveryIntent is false", () => {
    expect(isRoomDiscoveryIntent("la Junior Suite fait combien de mètres carrés ?")).toBe(false);
  });
});

describe("ROOM_DISCOVERY — [H] 'les chambres ?' : elliptical catalogue request", () => {
  it("isRoomDiscoveryIntent is true even with no verb at all", () => {
    expect(isRoomDiscoveryIntent("les chambres ?")).toBe(true);
  });
});

describe("ROOM_DISCOVERY — [I] 'vous avez un parking ?' : no activation", () => {
  it("isRoomDiscoveryIntent is false", () => {
    expect(isRoomDiscoveryIntent("vous avez un parking ?")).toBe(false);
  });

  it("as a fresh turn, roomDiscoveryIntentDetected stays false", () => {
    expect(computeSignalsForTurn("vous avez un parking ?", []).roomDiscoveryIntentDetected).toBe(false);
  });
});

describe("answer.ts wiring — roomDiscoveryIntentDetected/continuation/party-merge are all threaded through exactly like every other orthogonal signal", () => {
  it("[continuation computed once, up front] lastAssistantMessageIndicatesRoomDiscoveryContinuation(historyInput) feeds roomDiscoveryIntentDetected, which itself overrides a fresh booking match", () => {
    expect(source).toMatch(
      /const roomDiscoveryContinuationSignal = lastAssistantMessageIndicatesRoomDiscoveryContinuation\(historyInput\);/
    );
    expect(source).toMatch(
      /const roomDiscoveryIntentDetected =\s*\n?\s*isRoomDiscoveryIntent\(message\) \|\| \(roomDiscoveryContinuationSignal && !isBookingIntent\(message\)\);/
    );
  });

  it("[precedence guard unchanged] bookingIntentDetected's computation is still gated by !roomDiscoveryIntentDetected", () => {
    expect(source).toMatch(
      /const bookingIntentDetected =\s*\n?\s*!roomDiscoveryIntentDetected && \(isBookingIntent\(message\) \|\| lastAssistantMessageIndicatesBookingIntent\(historyInput\)\);/
    );
  });

  it("[party-merge fix wired in] the stay-request resolution block calls mergeValidatedStayRequestIntoParty, not the old two-field AND-gate", () => {
    expect(source).toMatch(/party = mergeValidatedStayRequestIntoParty\(party, validatedState\);/);
    expect(source).not.toMatch(/validatedState\.adults !== null && validatedState\.childrenCount !== null\)\s*\{\s*\n\s*party = \{/);
  });

  it("[deterministic history scan wired in BEFORE the OpenAI-based resolution] extractPartySizeFromHistory is called unconditionally, ahead of the stay-context gate — the fix for the measured resolveStayRequestFromHistory non-determinism", () => {
    const deterministicIndex = source.indexOf("party = extractPartySizeFromHistory(historyInput) ?? party;");
    const gateIndex = source.indexOf("if (stayContextRelevant || roomDiscoveryIntentDetected || bookingIntentDetected) {");
    const llmCallIndex = source.indexOf("await resolveStayRequestFromHistory(");
    expect(deterministicIndex).toBeGreaterThan(-1);
    expect(deterministicIndex).toBeLessThan(gateIndex);
    expect(gateIndex).toBeLessThan(llmCallIndex);
  });

  it("[precise-mention override wired in] findMentionedAccommodation feeds mentionsPreciseAccommodation, passed to both branches", () => {
    expect(source).toMatch(/const mentionedAccommodation = findMentionedAccommodation\(/);
    expect(source).toMatch(/const mentionsPreciseAccommodation = mentionedAccommodation !== null;/);
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    expect(answerQuestionFn.slice(answerQuestionFn.indexOf("return answerGrounded"))).toMatch(/mentionsPreciseAccommodation,/);
    expect(answerQuestionFn.slice(answerQuestionFn.indexOf("return answerNoContext"))).toMatch(/mentionsPreciseAccommodation,/);
  });

  it("[both replies get marked] answerGrounded and answerNoContext both call withRoomDiscoveryMarker, gated on roomDiscoveryIntentDetected", () => {
    function sliceFn(name: string, nextName: string): string {
      const start = source.indexOf(`async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf(nextName, start);
      return end === -1 ? source.slice(start) : source.slice(start, end);
    }
    for (const fn of [sliceFn("answerGrounded", "async function answerNoContext"), sliceFn("answerNoContext", "async function loadHistory")]) {
      expect(fn).toMatch(/if \(roomDiscoveryIntentDetected\) \{\s*\n\s*reply = withRoomDiscoveryMarker\(reply\);/);
    }
  });

  it("[retrieval + stay-context resolution still widen for room discovery] unchanged shape for retrieval; the stay-request gate itself was extended by the BOOKING TUNNEL chantier to also include bookingIntentDetected (see answer.accommodationRetrieval.test.ts's own test for why)", () => {
    expect(source).toMatch(/limit: stayContextRelevant \|\| roomDiscoveryIntentDetected \? ACCOMMODATION_RETRIEVAL_LIMIT : RETRIEVAL_LIMIT,/);
    expect(source).toMatch(/if \(stayContextRelevant \|\| roomDiscoveryIntentDetected \|\| bookingIntentDetected\) \{/);
  });
});
