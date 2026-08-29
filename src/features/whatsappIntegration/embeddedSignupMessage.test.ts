import { describe, expect, it } from "vitest";
import {
  META_EMBEDDED_SIGNUP_ORIGIN,
  classifyEmbeddedSignupOutcome,
  isSafeFinishEvent,
  parseEmbeddedSignupMessage,
} from "./embeddedSignupMessage";

const ORIGIN = META_EMBEDDED_SIGNUP_ORIGIN;

function messageEvent(data: unknown, origin: string = ORIGIN) {
  return { origin, data };
}

describe("parseEmbeddedSignupMessage", () => {
  it("[wrong origin] returns null even for an otherwise well-formed payload", () => {
    const result = parseEmbeddedSignupMessage(messageEvent({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: {} }, "https://evil.example.com"), ORIGIN);
    expect(result).toBeNull();
  });

  it("[non-JSON string data] returns null, never throws", () => {
    expect(() => parseEmbeddedSignupMessage(messageEvent("not-json-{"), ORIGIN)).not.toThrow();
    expect(parseEmbeddedSignupMessage(messageEvent("not-json-{"), ORIGIN)).toBeNull();
  });

  it("[non-object payload] returns null", () => {
    expect(parseEmbeddedSignupMessage(messageEvent(42), ORIGIN)).toBeNull();
    expect(parseEmbeddedSignupMessage(messageEvent(null), ORIGIN)).toBeNull();
  });

  it("[wrong type] returns null", () => {
    expect(parseEmbeddedSignupMessage(messageEvent({ type: "SOMETHING_ELSE", event: "FINISH" }), ORIGIN)).toBeNull();
  });

  it("[unrecognized event name] returns null — never guessed at", () => {
    expect(parseEmbeddedSignupMessage(messageEvent({ type: "WA_EMBEDDED_SIGNUP", event: "SOMETHING_NEW_FROM_META" }), ORIGIN)).toBeNull();
  });

  it("[CANCEL] extracts current_step", () => {
    const result = parseEmbeddedSignupMessage(
      messageEvent({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER" } }),
      ORIGIN
    );
    expect(result).toEqual({ event: "CANCEL", currentStep: "PHONE_NUMBER" });
  });

  it("[CANCEL without data] currentStep is null, never invented", () => {
    const result = parseEmbeddedSignupMessage(messageEvent({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL" }), ORIGIN);
    expect(result).toEqual({ event: "CANCEL", currentStep: null });
  });

  it("[ERROR]", () => {
    expect(parseEmbeddedSignupMessage(messageEvent({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR" }), ORIGIN)).toEqual({ event: "ERROR" });
  });

  it.each(["FINISH", "FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_OBO_MIGRATION", "FINISH_GRANT_ONLY_API_ACCESS"])(
    "[%s] extracts waba/phone/business ids",
    (eventName) => {
      const result = parseEmbeddedSignupMessage(
        messageEvent({ type: "WA_EMBEDDED_SIGNUP", event: eventName, data: { waba_id: "waba-1", phone_number_id: "phone-1", business_id: "biz-1" } }),
        ORIGIN
      );
      expect(result).toEqual({ event: eventName, wabaId: "waba-1", phoneNumberId: "phone-1", businessId: "biz-1" });
    }
  );

  it("[FINISH without data] ids are null, never invented", () => {
    const result = parseEmbeddedSignupMessage(messageEvent({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH" }), ORIGIN);
    expect(result).toEqual({ event: "FINISH", wabaId: null, phoneNumberId: null, businessId: null });
  });
});

describe("isSafeFinishEvent", () => {
  it("[FINISH_OBO_MIGRATION] NOT safe — could not be confirmed non-destructive", () => {
    expect(isSafeFinishEvent("FINISH_OBO_MIGRATION")).toBe(false);
  });

  it.each(["FINISH", "FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", "FINISH_GRANT_ONLY_API_ACCESS"])("[%s] safe", (eventName) => {
    expect(isSafeFinishEvent(eventName as never)).toBe(true);
  });
});

describe("classifyEmbeddedSignupOutcome", () => {
  it("[no message, no code] cancelled — assume the user closed the popup", () => {
    expect(classifyEmbeddedSignupOutcome(null, false)).toEqual({ status: "cancelled" });
  });

  it("[no message, but a code somehow present] error — the two channels disagree, never guessed at", () => {
    expect(classifyEmbeddedSignupOutcome(null, true)).toEqual({ status: "error" });
  });

  it("[CANCEL message] cancelled regardless of code", () => {
    expect(classifyEmbeddedSignupOutcome({ event: "CANCEL", currentStep: null }, true)).toEqual({ status: "cancelled" });
    expect(classifyEmbeddedSignupOutcome({ event: "CANCEL", currentStep: null }, false)).toEqual({ status: "cancelled" });
  });

  it("[ERROR message] error regardless of code", () => {
    expect(classifyEmbeddedSignupOutcome({ event: "ERROR" }, true)).toEqual({ status: "error" });
  });

  it("[FINISH_OBO_MIGRATION] unsupported_flow — the STOP case, never continued", () => {
    const result = classifyEmbeddedSignupOutcome({ event: "FINISH_OBO_MIGRATION", wabaId: "w", phoneNumberId: "p", businessId: "b" }, true);
    expect(result).toEqual({ status: "unsupported_flow" });
  });

  it("[FINISH_OBO_MIGRATION without a code] still unsupported_flow, never falls through to error", () => {
    const result = classifyEmbeddedSignupOutcome({ event: "FINISH_OBO_MIGRATION", wabaId: null, phoneNumberId: null, businessId: null }, false);
    expect(result).toEqual({ status: "unsupported_flow" });
  });

  it("[safe FINISH without a code] error — the two channels disagree", () => {
    const result = classifyEmbeddedSignupOutcome({ event: "FINISH", wabaId: "w", phoneNumberId: "p", businessId: "b" }, false);
    expect(result).toEqual({ status: "error" });
  });

  it("[safe FINISH with a code] awaiting_finalization, carrying the event and display-only ids through", () => {
    const result = classifyEmbeddedSignupOutcome(
      { event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", wabaId: "waba-1", phoneNumberId: "phone-1", businessId: "biz-1" },
      true
    );
    expect(result).toEqual({
      status: "awaiting_finalization",
      event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      businessId: "biz-1",
    });
  });
});
