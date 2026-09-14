import { describe, expect, it } from "vitest";
import { evaluateMarketingEligibility, evaluatePostStayEligibility } from "./eligibility";

const allowed = { email: "client@example.com", marketingAllowed: true, hotelExcluded: false, customerUnsubscribed: false };

describe("loyalty eligibility", () => {
  it("allows an explicitly eligible marketing customer", () => {
    expect(evaluateMarketingEligibility(allowed)).toEqual({ eligible: true });
  });

  it("gives customer unsubscribe absolute priority", () => {
    expect(evaluateMarketingEligibility({ ...allowed, customerUnsubscribed: true, hotelExcluded: true })).toEqual({
      eligible: false,
      reason: "customer_unsubscribed",
    });
  });

  it("blocks a hotel-excluded customer", () => {
    expect(evaluateMarketingEligibility({ ...allowed, hotelExcluded: true })).toEqual({ eligible: false, reason: "hotel_excluded" });
  });

  it("fails closed when marketing is not explicitly allowed", () => {
    expect(evaluateMarketingEligibility({ ...allowed, marketingAllowed: false })).toEqual({
      eligible: false,
      reason: "marketing_not_allowed",
    });
  });

  it("does not let manual campaign selection affect eligibility", () => {
    const manuallySelected = { ...allowed, hotelExcluded: true };
    expect(evaluateMarketingEligibility(manuallySelected)).toEqual({ eligible: false, reason: "hotel_excluded" });
  });

  it("keeps post-stay service separate from marketing consent", () => {
    expect(evaluatePostStayEligibility({ ...allowed, marketingAllowed: false })).toEqual({ eligible: true });
  });

  it("still blocks post-stay follow-up after unsubscribe or hotel exclusion", () => {
    expect(evaluatePostStayEligibility({ ...allowed, customerUnsubscribed: true })).toEqual({ eligible: false, reason: "customer_unsubscribed" });
    expect(evaluatePostStayEligibility({ ...allowed, hotelExcluded: true })).toEqual({ eligible: false, reason: "hotel_excluded" });
  });
});

