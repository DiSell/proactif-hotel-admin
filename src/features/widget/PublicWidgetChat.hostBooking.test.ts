import { describe, expect, it } from "vitest";
import { isValidBookingResultMessage } from "./PublicWidgetChat";

/**
 * Real unit test for the one piece of the host-booking bridge that's pure
 * and DOM-independent — the payload shape check. The surrounding
 * event.source/event.origin checks need a real MessageEvent/window and are
 * covered by the widgetScript.test.ts source-guards for the other side of
 * the bridge (public/widget.js) instead — same constraint documented
 * throughout this codebase (vitest's environment is "node", no DOM/jsdom).
 */
describe("isValidBookingResultMessage", () => {
  it("[valid, triggered] accepted", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "triggered" })).toBe(true);
  });

  it("[valid, unavailable] accepted", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "unavailable" })).toBe(true);
  });

  it("[wrong type] rejected", () => {
    expect(isValidBookingResultMessage({ type: "something-else", status: "triggered" })).toBe(false);
  });

  it("[wrong/foreign status] rejected — only 'triggered' and 'unavailable' exist", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "confirmed" })).toBe(false);
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "success" })).toBe(false);
  });

  it("[missing status] rejected", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result" })).toBe(false);
  });

  it("[not an object] rejected — string, number, array, null, undefined", () => {
    expect(isValidBookingResultMessage("proactif:booking-result")).toBe(false);
    expect(isValidBookingResultMessage(42)).toBe(false);
    expect(isValidBookingResultMessage(["proactif:booking-result"])).toBe(false);
    expect(isValidBookingResultMessage(null)).toBe(false);
    expect(isValidBookingResultMessage(undefined)).toBe(false);
  });

  it("[extra fields tolerated on the discriminant check itself, but never used] presence of extra keys doesn't itself cause rejection — this function only checks type/status, callers never read anything else", () => {
    expect(isValidBookingResultMessage({ type: "proactif:booking-result", status: "triggered", selector: "#hack" })).toBe(true);
  });
});
