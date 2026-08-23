import { describe, expect, it } from "vitest";
import { decideRetry, MAX_AVAILABILITY_CHECK_MS } from "./retryPolicy";

describe("decideRetry — RATE_LIMITED", () => {
  it("respects retryAfterSeconds (converted to ms)", () => {
    const decision = decideRetry({ code: "RATE_LIMITED", retryAfterSeconds: 1 }, 1, 0);
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(1000);
  });

  it("caps an absurdly large retryAfterSeconds rather than trusting it blindly", () => {
    const decision = decideRetry({ code: "RATE_LIMITED", retryAfterSeconds: 3600 }, 1, 0);
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeLessThan(3600 * 1000);
  });

  it("does not retry if the delay would exceed the total time budget", () => {
    const decision = decideRetry({ code: "RATE_LIMITED", retryAfterSeconds: 2 }, 1, MAX_AVAILABILITY_CHECK_MS - 500);
    expect(decision.retry).toBe(false);
  });
});

describe("decideRetry — never-retry codes", () => {
  it("AUTH_ERROR never retries, regardless of attempt number", () => {
    expect(decideRetry({ code: "AUTH_ERROR" }, 1, 0).retry).toBe(false);
    expect(decideRetry({ code: "AUTH_ERROR" }, 5, 0).retry).toBe(false);
  });

  it("NO_PROVIDER never retries", () => {
    expect(decideRetry({ code: "NO_PROVIDER" }, 1, 0).retry).toBe(false);
  });

  it("MISSING_REQUIRED_INPUT, CAPABILITY_NOT_SUPPORTED, MISSING_MAPPING, INVALID_RESPONSE never retry", () => {
    for (const code of ["MISSING_REQUIRED_INPUT", "CAPABILITY_NOT_SUPPORTED", "MISSING_MAPPING", "INVALID_RESPONSE"] as const) {
      expect(decideRetry({ code }, 1, 0).retry).toBe(false);
    }
  });
});

describe("decideRetry — TIMEOUT", () => {
  it("retries a bounded number of times", () => {
    expect(decideRetry({ code: "TIMEOUT" }, 1, 0).retry).toBe(true);
    expect(decideRetry({ code: "TIMEOUT" }, 2, 0).retry).toBe(true);
    // Third attempt exceeds the bounded schedule.
    expect(decideRetry({ code: "TIMEOUT" }, 3, 0).retry).toBe(false);
  });

  it("never exceeds the total time budget even mid-schedule", () => {
    const decision = decideRetry({ code: "TIMEOUT" }, 1, MAX_AVAILABILITY_CHECK_MS);
    expect(decision.retry).toBe(false);
  });
});

describe("decideRetry — total budget", () => {
  it("MAX_AVAILABILITY_CHECK_MS is a real, finite, reasonably small bound", () => {
    expect(MAX_AVAILABILITY_CHECK_MS).toBeGreaterThan(0);
    expect(MAX_AVAILABILITY_CHECK_MS).toBeLessThanOrEqual(15_000);
  });
});
