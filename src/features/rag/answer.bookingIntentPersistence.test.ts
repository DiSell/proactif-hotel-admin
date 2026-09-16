import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isBookingIntent, buildBookingAction } from "./answer";
import { lastAssistantMessageIndicatesBookingIntent, withBookingIntentMarker } from "./bookingIntentContinuation";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Real-invocation, multi-turn reproduction of the reported bug and its fix —
 * chains the exact same pure, exported functions answerQuestion() itself
 * calls (isBookingIntent, lastAssistantMessageIndicatesBookingIntent,
 * buildBookingAction), in the exact order answer.ts calls them, without
 * mocking OpenAI/Supabase — this codebase has no mocking infrastructure for
 * either (see every other answer.ts test file's own doc comment), so
 * answerQuestion() itself can't be invoked directly; this is the closest a
 * real invocation gets to the full turn without touching that constraint,
 * genuinely exercising decision logic rather than asserting on source text.
 */

const HOST_WIDGET_HOTEL = {
  booking_action_mode: "host_widget" as const,
  booking_url: null,
  host_booking_trigger: { strategy: "click" as const, selector: "#resa-toggle-menu" },
};

/** Simulates answer.ts's own combined signal for one turn, given the conversation history loaded before this turn (never including the current message, same as answer.ts's own loadHistory ordering). */
function bookingIntentDetectedForTurn(message: string, history: { role: "user" | "assistant"; content: string }[]): boolean {
  return isBookingIntent(message) || lastAssistantMessageIndicatesBookingIntent(history);
}

describe("multi-turn booking CTA persistence — exact reported reproduction", () => {
  it("[turn 1] 'je veus reserver une chambre' — fresh keyword match, CTA shown, reply gets marked", () => {
    const bookingIntentDetected = bookingIntentDetectedForTurn("je veus reserver une chambre", []);
    expect(bookingIntentDetected).toBe(true);

    const action = buildBookingAction(bookingIntentDetected, HOST_WIDGET_HOTEL);
    expect(action).toEqual({ type: "host_booking", label: "Réserver" });
  });

  it("[turn 2] '20/09 au 22/09 2 presonnes' — no booking keyword on its own (the bug: isBookingIntent alone is false here)", () => {
    expect(isBookingIntent("20/09 au 22/09 2 presonnes")).toBe(false);
  });

  it("[turn 2, fixed] the CTA is still shown because turn 1's reply carried the continuation marker", () => {
    const turn1Reply = withBookingIntentMarker("D'accord, quelles sont vos dates de séjour et le nombre de personnes ?");
    const historyBeforeTurn2 = [
      { role: "user" as const, content: "je veus reserver une chambre" },
      { role: "assistant" as const, content: turn1Reply },
    ];

    const bookingIntentDetected = bookingIntentDetectedForTurn("20/09 au 22/09 2 presonnes", historyBeforeTurn2);
    expect(bookingIntentDetected).toBe(true);

    const action = buildBookingAction(bookingIntentDetected, HOST_WIDGET_HOTEL);
    expect(action).toEqual({ type: "host_booking", label: "Réserver" });
  });

  it("[turn 2 reply, re-marked] the marker is re-applied so a hypothetical turn 3 would still see the CTA", () => {
    const turn1Reply = withBookingIntentMarker("D'accord, quelles sont vos dates de séjour et le nombre de personnes ?");
    const historyBeforeTurn2 = [
      { role: "user" as const, content: "je veus reserver une chambre" },
      { role: "assistant" as const, content: turn1Reply },
    ];
    const bookingIntentDetectedTurn2 = bookingIntentDetectedForTurn("20/09 au 22/09 2 presonnes", historyBeforeTurn2);
    const turn2Reply = bookingIntentDetectedTurn2
      ? withBookingIntentMarker("J'ai bien noté votre demande pour un séjour du 20 au 22 septembre 2026, pour 2 personnes.")
      : "J'ai bien noté votre demande pour un séjour du 20 au 22 septembre 2026, pour 2 personnes.";

    const historyBeforeTurn3 = [...historyBeforeTurn2, { role: "user" as const, content: "20/09 au 22/09 2 presonnes" }, { role: "assistant" as const, content: turn2Reply }];

    expect(lastAssistantMessageIndicatesBookingIntent(historyBeforeTurn3)).toBe(true);
  });
});

describe("multi-turn booking CTA persistence — documentary conversation must never trigger it", () => {
  it("[turn 1] a pure documentary question about a room never sets the marker", () => {
    const message = "Est-ce que la Suite Deluxe a la climatisation ?";
    const bookingIntentDetected = bookingIntentDetectedForTurn(message, []);
    expect(bookingIntentDetected).toBe(false);

    const action = buildBookingAction(bookingIntentDetected, HOST_WIDGET_HOTEL);
    expect(action).toBeNull();
  });

  it("[turn 2] 'Et pour 2 personnes ?' — CTA must NOT appear just because a party-size-like phrase follows an unmarked reply", () => {
    // Turn 1's reply was never marked (no booking intent was ever detected), so history carries no marker at all — exactly what a real documentary exchange produces.
    const historyBeforeTurn2 = [
      { role: "user" as const, content: "Est-ce que la Suite Deluxe a la climatisation ?" },
      { role: "assistant" as const, content: "Oui, la Suite Deluxe dispose de la climatisation réversible." },
    ];

    const bookingIntentDetected = bookingIntentDetectedForTurn("Et pour 2 personnes ?", historyBeforeTurn2);
    expect(bookingIntentDetected).toBe(false);

    const action = buildBookingAction(bookingIntentDetected, HOST_WIDGET_HOTEL);
    expect(action).toBeNull();
  });
});

describe("answer.ts wiring — the marker is actually written into the persisted/returned reply", () => {
  function sliceFn(name: string, nextName: string): string {
    const start = source.indexOf(`async function ${name}`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(nextName, start);
    return end === -1 ? source.slice(start) : source.slice(start, end);
  }

  it("[both branches import and call withBookingIntentMarker, gated on bookingIntentDetected]", () => {
    expect(source).toMatch(/import \{ lastAssistantMessageIndicatesBookingIntent, withBookingIntentMarker \} from "\.\/bookingIntentContinuation";/);

    const groundedFn = sliceFn("answerGrounded", "async function answerNoContext");
    const noContextFn = sliceFn("answerNoContext", "async function loadHistory");
    for (const fn of [groundedFn, noContextFn]) {
      expect(fn).toMatch(/if \(bookingIntentDetected\) \{\s*\n\s*reply = withBookingIntentMarker\(reply\);/);
    }
  });

  it("[marker applied AFTER partner/spa flow suffixes, still inside the try block] never bypasses those, never applied after the catch", () => {
    const groundedFn = sliceFn("answerGrounded", "async function answerNoContext");
    const spaBranchIndex = groundedFn.indexOf("spaBookingPhonePrompt = flowResult.spaBookingPhonePrompt;");
    const markerIndex = groundedFn.indexOf("reply = withBookingIntentMarker(reply);");
    const catchIndex = groundedFn.indexOf("} catch (err) {");
    expect(spaBranchIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(spaBranchIndex);
    expect(markerIndex).toBeLessThan(catchIndex);
  });
});
