import { describe, expect, it } from "vitest";
import { lastAssistantMessageIndicatesRoomDiscoveryContinuation, withRoomDiscoveryMarker } from "./roomDiscoveryContinuation";

/** Mirrors bookingIntentContinuation.test.ts's own marker test suite exactly — same mechanism, third domain. */
describe("withRoomDiscoveryMarker / lastAssistantMessageIndicatesRoomDiscoveryContinuation", () => {
  it("[round trip] a reply tagged with the marker is recognized as a continuation", () => {
    const tagged = withRoomDiscoveryMarker("Bien sûr. Pour combien de personnes ?");
    const history = [
      { role: "user" as const, content: "montre moi les chambres" },
      { role: "assistant" as const, content: tagged },
      { role: "user" as const, content: "2" },
    ];
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation(history)).toBe(true);
  });

  it("[the marker is invisible] never a visible substring like an HTML comment or a bracketed tag", () => {
    const tagged = withRoomDiscoveryMarker("Bonjour");
    expect(tagged).not.toMatch(/<!--|\[|\]/);
  });

  it("[only the MOST RECENT assistant message is checked]", () => {
    const history = [
      { role: "assistant" as const, content: withRoomDiscoveryMarker("ancien message") },
      { role: "user" as const, content: "autre chose" },
      { role: "assistant" as const, content: "Bonjour, comment puis-je vous aider ?" },
      { role: "user" as const, content: "merci" },
    ];
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation(history)).toBe(false);
  });

  it("[no assistant message at all] returns false", () => {
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation([{ role: "user" as const, content: "bonjour" }])).toBe(false);
  });

  it("[empty history] returns false", () => {
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation([])).toBe(false);
  });

  it("[distinct from booking's own marker] a booking-marked reply is never mistaken for a room-discovery one", async () => {
    const { withBookingIntentMarker } = await import("./bookingIntentContinuation");
    const history = [{ role: "assistant" as const, content: withBookingIntentMarker("Quelles sont vos dates ?") }];
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation(history)).toBe(false);
  });

  it("[distinct from spa's own marker] a spa-continuation-marked reply is never mistaken for a room-discovery one", async () => {
    const { withSpaContinuationMarker } = await import("./spaBookingFlow");
    const history = [{ role: "assistant" as const, content: withSpaContinuationMarker("Quel créneau souhaitez-vous ?") }];
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation(history)).toBe(false);
  });
});
