import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Twilio from "twilio";
import { readTwilioConfigFromEnv, readTwilioWebhookSignatureConfigFromEnv, validateTwilioSignature } from "./twilioSmsProvider";

/**
 * PHASE 1 — twilioSmsProvider.ts is never exercised against the real
 * Twilio network here: the `twilio` client's `messages.create` is mocked
 * per sendSms test (same "mock the SDK's own network boundary, run
 * everything else for real" discipline as
 * whatsapp/metaProvider.test.ts mocking global fetch). Signature
 * validation tests use the SDK's OWN `Twilio.getExpectedTwilioSignature`
 * to compute a real, valid signature — never a hand-rolled HMAC — so these
 * tests prove real integration with the official validator, not a
 * reimplementation of it.
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

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("readTwilioConfigFromEnv", () => {
  it("[fully configured] returns the config object", () => {
    setFullTwilioEnv();
    expect(readTwilioConfigFromEnv()).toEqual({
      accountSid: "ACtest0000000000000000000000000000",
      authToken: "test-auth-token",
      from: "+15005550006",
    });
  });

  it.each(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_FROM"])("[%s missing] returns null", (missingVar) => {
    setFullTwilioEnv();
    delete process.env[missingVar];
    expect(readTwilioConfigFromEnv()).toBeNull();
  });

  it("[nothing set] returns null", () => {
    clearTwilioEnv();
    expect(readTwilioConfigFromEnv()).toBeNull();
  });
});

describe("readTwilioWebhookSignatureConfigFromEnv — decoupled from the send config", () => {
  it("[only TWILIO_AUTH_TOKEN set] returns a config, independent of ACCOUNT_SID/SMS_FROM", () => {
    clearTwilioEnv();
    process.env.TWILIO_AUTH_TOKEN = "webhook-only-token";
    expect(readTwilioWebhookSignatureConfigFromEnv()).toEqual({ authToken: "webhook-only-token" });
  });

  it("[TWILIO_AUTH_TOKEN missing] returns null", () => {
    clearTwilioEnv();
    expect(readTwilioWebhookSignatureConfigFromEnv()).toBeNull();
  });
});

describe("validateTwilioSignature — delegates to the official Twilio SDK validator, never reimplemented", () => {
  const authToken = "the-real-auth-token";
  const url = "https://example.com/api/webhooks/twilio/sms";
  const params = { MessageSid: "SM123", From: "+33612345678", To: "+15005550006", Body: "1 ABC7" };

  it("[valid signature, computed via the SDK's own getExpectedTwilioSignature] accepted", () => {
    const signature = Twilio.getExpectedTwilioSignature(authToken, url, params);
    expect(validateTwilioSignature(url, signature, params, { authToken })).toBe(true);
  });

  it("[wrong signature] rejected", () => {
    expect(validateTwilioSignature(url, "invalid-signature", params, { authToken })).toBe(false);
  });

  it("[missing signature header] rejected", () => {
    expect(validateTwilioSignature(url, null, params, { authToken })).toBe(false);
  });

  it("[config null — not configured] rejected regardless of the signature supplied", () => {
    const signature = Twilio.getExpectedTwilioSignature(authToken, url, params);
    expect(validateTwilioSignature(url, signature, params, null)).toBe(false);
  });

  it("[tampered params after signing] rejected — the signature covers the exact param set", () => {
    const signature = Twilio.getExpectedTwilioSignature(authToken, url, params);
    expect(validateTwilioSignature(url, signature, { ...params, Body: "2 ABC7" }, { authToken })).toBe(false);
  });

  it("[HTTPS URL as signed by Twilio behind a proxy, exact match required] a scheme mismatch (http vs https) invalidates the signature — proof that resolvePublicRequestUrl's own job (webhook.test.ts) matters", () => {
    const signature = Twilio.getExpectedTwilioSignature(authToken, url, params);
    const httpUrl = url.replace("https://", "http://");
    expect(validateTwilioSignature(httpUrl, signature, params, { authToken })).toBe(false);
  });
});

describe("createTwilioSmsProvider — sendSms (Twilio client mocked, NEVER a real network call)", () => {
  const config = { accountSid: "ACtest", authToken: "token", from: "+15005550006" };

  beforeEach(() => {
    vi.resetModules();
  });

  it("[success] returns providerMessageId mapped from the SDK's own message.sid", async () => {
    const create = vi.fn(async () => ({ sid: "SM_success_123" }));
    vi.doMock("twilio", () => ({ default: Object.assign(vi.fn(() => ({ messages: { create } })), { twiml: Twilio.twiml }) }));
    const { createTwilioSmsProvider } = await import("./twilioSmsProvider");
    const provider = createTwilioSmsProvider(config);

    const result = await provider.sendSms({ toE164: "+33612345678", body: "test" });

    expect(result).toEqual({ ok: true, providerMessageId: "SM_success_123" });
    vi.doUnmock("twilio");
  });

  it("[payload sent to the SDK] body/from/to map exactly onto client.messages.create's own parameters", async () => {
    const create = vi.fn(async () => ({ sid: "SM_x" }));
    vi.doMock("twilio", () => ({ default: Object.assign(vi.fn(() => ({ messages: { create } })), { twiml: Twilio.twiml }) }));
    const { createTwilioSmsProvider } = await import("./twilioSmsProvider");
    const provider = createTwilioSmsProvider(config);

    await provider.sendSms({ toE164: "+33612345678", body: "Le 1837 — nouvelle demande" });

    expect(create).toHaveBeenCalledWith({ body: "Le 1837 — nouvelle demande", from: "+15005550006", to: "+33612345678" });
    vi.doUnmock("twilio");
  });

  it("[Twilio rejects with a 4xx RestException] returns provider_error, certain, never throws", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.fn(async () => {
      throw Object.assign(new Error("Invalid 'To' Phone Number"), { status: 400, code: 21211 });
    });
    vi.doMock("twilio", () => ({ default: Object.assign(vi.fn(() => ({ messages: { create } })), { twiml: Twilio.twiml }) }));
    const { createTwilioSmsProvider } = await import("./twilioSmsProvider");
    const provider = createTwilioSmsProvider(config);

    const result = await provider.sendSms({ toE164: "+33612345678", body: "test" });

    expect(result).toEqual({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    for (const call of consoleErrorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/Invalid 'To' Phone Number|33612345678/);
    }
    vi.doUnmock("twilio");
  });

  it("[network-level exception, no HTTP status] returns provider_unknown, ambiguous, never provider_error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.doMock("twilio", () => ({ default: Object.assign(vi.fn(() => ({ messages: { create } })), { twiml: Twilio.twiml }) }));
    const { createTwilioSmsProvider } = await import("./twilioSmsProvider");
    const provider = createTwilioSmsProvider(config);

    const result = await provider.sendSms({ toE164: "+33612345678", body: "test" });

    expect(result).toEqual({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
    vi.doUnmock("twilio");
  });

  it.each([500, 502, 503, 504])("[HTTP %s RestException] returns provider_unknown, ambiguous", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const create = vi.fn(async () => {
      throw Object.assign(new Error("server error"), { status });
    });
    vi.doMock("twilio", () => ({ default: Object.assign(vi.fn(() => ({ messages: { create } })), { twiml: Twilio.twiml }) }));
    const { createTwilioSmsProvider } = await import("./twilioSmsProvider");
    const provider = createTwilioSmsProvider(config);

    const result = await provider.sendSms({ toE164: "+33612345678", body: "test" });

    expect(result).toEqual({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
    vi.doUnmock("twilio");
  });
});
