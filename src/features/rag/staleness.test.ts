import { describe, expect, it } from "vitest";
import { VOLATILE_STALENESS_DAYS, daysSince, isStale } from "./staleness";

const NOW = new Date("2026-08-29T12:00:00.000Z");

describe("daysSince", () => {
  it("returns null when iso is null — never fabricates a date", () => {
    expect(daysSince(null, NOW)).toBeNull();
  });

  it("returns 0 for a timestamp earlier today", () => {
    expect(daysSince("2026-08-29T00:00:00.000Z", NOW)).toBe(0);
  });

  it("returns the exact whole-day count for an older timestamp", () => {
    expect(daysSince("2026-08-22T12:00:00.000Z", NOW)).toBe(7);
  });
});

describe("isStale", () => {
  it("a null iso (never synced) is not 'stale' — that is a distinct 'no data' state for callers to handle separately", () => {
    expect(isStale(null, VOLATILE_STALENESS_DAYS, NOW)).toBe(false);
  });

  it("exactly VOLATILE_STALENESS_DAYS old is NOT stale — the threshold is exclusive (> days, not >=)", () => {
    const exactlyOnThreshold = new Date(NOW.getTime() - VOLATILE_STALENESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(exactlyOnThreshold, VOLATILE_STALENESS_DAYS, NOW)).toBe(false);
  });

  it("one day past VOLATILE_STALENESS_DAYS is stale", () => {
    const onePastThreshold = new Date(NOW.getTime() - (VOLATILE_STALENESS_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(onePastThreshold, VOLATILE_STALENESS_DAYS, NOW)).toBe(true);
  });

  it("a recent sync is never stale", () => {
    expect(isStale(NOW.toISOString(), VOLATILE_STALENESS_DAYS, NOW)).toBe(false);
  });

  it("respects a custom day threshold instead of the default", () => {
    const threeDaysAgo = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(isStale(threeDaysAgo, 2, NOW)).toBe(true);
    expect(isStale(threeDaysAgo, 5, NOW)).toBe(false);
  });
});
