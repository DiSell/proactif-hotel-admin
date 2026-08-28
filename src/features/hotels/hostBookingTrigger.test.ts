import { describe, expect, it } from "vitest";
import { bookingActionModeSchema, hostBookingTriggerSchema, parseHostBookingTrigger } from "./hostBookingTrigger";

describe("bookingActionModeSchema", () => {
  it("accepts 'url' and 'host_widget'", () => {
    expect(bookingActionModeSchema.safeParse("url").success).toBe(true);
    expect(bookingActionModeSchema.safeParse("host_widget").success).toBe(true);
  });

  it("rejects anything outside the closed enum", () => {
    expect(bookingActionModeSchema.safeParse("iframe_scrape").success).toBe(false);
    expect(bookingActionModeSchema.safeParse("").success).toBe(false);
    expect(bookingActionModeSchema.safeParse(null).success).toBe(false);
  });
});

describe("hostBookingTriggerSchema", () => {
  it("[valid] accepts exactly {strategy:'click', selector}", () => {
    const result = hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "#resa-toggle-menu" });
    expect(result.success).toBe(true);
  });

  it("[strategy closed] rejects any strategy other than the literal 'click' — this V1 implements no other strategy", () => {
    expect(hostBookingTriggerSchema.safeParse({ strategy: "scroll", selector: "#resa" }).success).toBe(false);
    expect(hostBookingTriggerSchema.safeParse({ strategy: "event", selector: "#resa" }).success).toBe(false);
  });

  it("[selector required] empty string rejected", () => {
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "" }).success).toBe(false);
  });

  it("[selector length bound] 200 chars accepted, 201 rejected", () => {
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "a".repeat(200) }).success).toBe(true);
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "a".repeat(201) }).success).toBe(false);
  });

  it("[.strict()] rejects any extra field — no javascript/eval/html/event escape hatch", () => {
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "#resa", javascript: "alert(1)" }).success).toBe(false);
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "#resa", eval: "1+1" }).success).toBe(false);
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "#resa", html: "<script>" }).success).toBe(false);
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "#resa", event: "click" }).success).toBe(false);
    expect(hostBookingTriggerSchema.safeParse({ strategy: "click", selector: "#resa", attribute: "value" }).success).toBe(false);
  });

  it("[missing fields] rejects a bare {} or a selector-only object", () => {
    expect(hostBookingTriggerSchema.safeParse({}).success).toBe(false);
    expect(hostBookingTriggerSchema.safeParse({ selector: "#resa" }).success).toBe(false);
  });
});

describe("parseHostBookingTrigger — fail-safe for untrusted/raw DB jsonb", () => {
  it("[valid] returns the parsed value", () => {
    expect(parseHostBookingTrigger({ strategy: "click", selector: "#resa-toggle-menu" })).toEqual({
      strategy: "click",
      selector: "#resa-toggle-menu",
    });
  });

  it("[null] returns null, never throws", () => {
    expect(parseHostBookingTrigger(null)).toBeNull();
  });

  it("[undefined] returns null", () => {
    expect(parseHostBookingTrigger(undefined)).toBeNull();
  });

  it("[malformed shapes] every one of these returns null, never throws", () => {
    expect(parseHostBookingTrigger("just a string")).toBeNull();
    expect(parseHostBookingTrigger(42)).toBeNull();
    expect(parseHostBookingTrigger([])).toBeNull();
    expect(parseHostBookingTrigger({ strategy: "javascript", code: "alert(1)" })).toBeNull();
    expect(parseHostBookingTrigger({ strategy: "click" })).toBeNull();
  });
});
