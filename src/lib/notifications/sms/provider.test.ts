import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Twilio from "twilio";

/**
 * getSmsProvider() resolves either the Twilio adapter (twilioSmsProvider.ts)
 * when fully configured, or a safe not-configured fallback otherwise — see
 * provider.ts. Mirrors whatsapp/provider.test.ts's own structure exactly.
 * The Twilio client itself is mocked — no real network call ever happens.
 */

const ORIGINAL_ENV = { ...process.env };

function clearTwilioEnv() {
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_SMS_FROM;
}

function setFullTwilioEnv() {
  process.env.TWILIO_ACCOUNT_SID = "ACtest0000000000000000000000000000";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_SMS_FROM = "+15005550006";
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.doUnmock("twilio");
});

describe("getSmsProvider — not configured", () => {
  it("[always returns a provider, never null/undefined]", async () => {
    clearTwilioEnv();
    const { getSmsProvider } = await import("./provider");
    expect(getSmsProvider()).toBeTruthy();
  });

  it("[sendSms resolves provider_not_configured, never throws]", async () => {
    clearTwilioEnv();
    const { getSmsProvider } = await import("./provider");

    const result = await getSmsProvider().sendSms({ toE164: "+33612345678", body: "test" });

    expect(result).toEqual({ ok: false, error: "provider_not_configured" });
  });

  it("[never touches the network — the twilio client is never constructed]", async () => {
    clearTwilioEnv();
    const TwilioMock = vi.fn();
    vi.doMock("twilio", () => ({ default: Object.assign(TwilioMock, { twiml: Twilio.twiml }) }));
    const { getSmsProvider } = await import("./provider");

    await getSmsProvider().sendSms({ toE164: "+33612345678", body: "test" });

    expect(TwilioMock).not.toHaveBeenCalled();
  });

  it("[logged, nothing sensitive to leak]", async () => {
    clearTwilioEnv();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getSmsProvider } = await import("./provider");

    await getSmsProvider().sendSms({ toE164: "+33612345678", body: "test" });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/no provider configured/i));
  });
});

describe("getSmsProvider — Twilio fully configured", () => {
  it("[uses the Twilio provider, not the not-configured fallback]", async () => {
    setFullTwilioEnv();
    const create = vi.fn(async () => ({ sid: "SM_x" }));
    vi.doMock("twilio", () => ({ default: Object.assign(vi.fn(() => ({ messages: { create } })), { twiml: Twilio.twiml }) }));
    const { getSmsProvider } = await import("./provider");

    const result = await getSmsProvider().sendSms({ toE164: "+33612345678", body: "test" });

    expect(result).not.toEqual({ ok: false, error: "provider_not_configured" });
  });

  it("[partial config still falls back to not-configured]", async () => {
    setFullTwilioEnv();
    delete process.env.TWILIO_SMS_FROM;
    const { getSmsProvider } = await import("./provider");

    const result = await getSmsProvider().sendSms({ toE164: "+33612345678", body: "test" });

    expect(result).toEqual({ ok: false, error: "provider_not_configured" });
  });
});

describe("getConfiguredSmsProvider", () => {
  it("[not configured] returns null", async () => {
    clearTwilioEnv();
    const { getConfiguredSmsProvider } = await import("./provider");
    expect(getConfiguredSmsProvider()).toBeNull();
  });

  it("[configured] returns a provider", async () => {
    setFullTwilioEnv();
    vi.doMock("twilio", () => ({ default: Object.assign(vi.fn(() => ({ messages: { create: vi.fn() } })), { twiml: Twilio.twiml }) }));
    const { getConfiguredSmsProvider } = await import("./provider");
    expect(getConfiguredSmsProvider()).not.toBeNull();
  });
});
