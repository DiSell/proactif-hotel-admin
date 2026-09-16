import { describe, expect, it } from "vitest";
import { lastAssistantMessageIndicatesBookingIntent, withBookingIntentMarker } from "./bookingIntentContinuation";

/** Mirrors spaBookingFlow.test.ts's own marker test suite exactly — same mechanism, different domain. */
describe("withBookingIntentMarker / lastAssistantMessageIndicatesBookingIntent", () => {
  it("[round trip] a reply tagged with the marker is recognized as a continuation", () => {
    const tagged = withBookingIntentMarker("Quelles sont vos dates de séjour ?");
    const history = [
      { role: "user" as const, content: "je veux réserver une chambre" },
      { role: "assistant" as const, content: tagged },
      { role: "user" as const, content: "20/09 au 22/09 2 personnes" },
    ];
    expect(lastAssistantMessageIndicatesBookingIntent(history)).toBe(true);
  });

  it("[the marker is invisible] never a visible substring like an HTML comment or a bracketed tag", () => {
    const tagged = withBookingIntentMarker("Bonjour");
    expect(tagged).not.toMatch(/<!--|\[|\]/);
  });

  it("[only the MOST RECENT assistant message is checked]", () => {
    const history = [
      { role: "assistant" as const, content: withBookingIntentMarker("ancien message") },
      { role: "user" as const, content: "autre chose" },
      { role: "assistant" as const, content: "Bonjour, comment puis-je vous aider ?" },
      { role: "user" as const, content: "merci" },
    ];
    expect(lastAssistantMessageIndicatesBookingIntent(history)).toBe(false);
  });

  it("[no assistant message at all] returns false", () => {
    expect(lastAssistantMessageIndicatesBookingIntent([{ role: "user" as const, content: "bonjour" }])).toBe(false);
  });

  it("[empty history] returns false", () => {
    expect(lastAssistantMessageIndicatesBookingIntent([])).toBe(false);
  });

  it("[distinct from spaBookingFlow.ts's own marker] a spa-continuation-marked reply is never mistaken for a booking-intent one", async () => {
    const { withSpaContinuationMarker } = await import("./spaBookingFlow");
    const history = [{ role: "assistant" as const, content: withSpaContinuationMarker("Quel créneau souhaitez-vous ?") }];
    expect(lastAssistantMessageIndicatesBookingIntent(history)).toBe(false);
  });
});
