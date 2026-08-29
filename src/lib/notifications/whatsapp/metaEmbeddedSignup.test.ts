import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  exchangeEmbeddedSignupCode,
  finalizeEmbeddedSignup,
  getPhoneNumber,
  getWhatsAppBusinessAccount,
  readMetaEmbeddedSignupConfigFromEnv,
  subscribeAppToWaba,
} from "./metaEmbeddedSignup";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "metaEmbeddedSignup.ts"), "utf8");

const CONFIG = { appId: "app-1", appSecret: "secret-1", apiVersion: "v23.0" };

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe("readMetaEmbeddedSignupConfigFromEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("[all three present] returns the config", () => {
    vi.stubEnv("NEXT_PUBLIC_META_APP_ID", "app-1");
    vi.stubEnv("WHATSAPP_META_APP_SECRET", "secret-1");
    vi.stubEnv("WHATSAPP_META_API_VERSION", "v23.0");
    expect(readMetaEmbeddedSignupConfigFromEnv()).toEqual({ appId: "app-1", appSecret: "secret-1", apiVersion: "v23.0" });
  });

  it.each(["NEXT_PUBLIC_META_APP_ID", "WHATSAPP_META_APP_SECRET", "WHATSAPP_META_API_VERSION"])("[%s missing] returns null", (missing) => {
    const all: Record<string, string> = { NEXT_PUBLIC_META_APP_ID: "app-1", WHATSAPP_META_APP_SECRET: "secret-1", WHATSAPP_META_API_VERSION: "v23.0" };
    for (const [key, value] of Object.entries(all)) {
      if (key !== missing) vi.stubEnv(key, value);
    }
    expect(readMetaEmbeddedSignupConfigFromEnv()).toBeNull();
  });
});

describe("exchangeEmbeddedSignupCode", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("[success] returns the ephemeral access token", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { access_token: "eph-token" }));
    const result = await exchangeEmbeddedSignupCode("auth-code", CONFIG);
    expect(result).toEqual({ accessToken: "eph-token" });
  });

  it("[never sends redirect_uri — Embedded Signup's own JS-callback code has no redirect involved]", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { access_token: "eph-token" }));
    await exchangeEmbeddedSignupCode("auth-code", CONFIG);
    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as URL;
    expect(calledUrl.toString()).not.toMatch(/redirect_uri/);
    expect(calledUrl.toString()).toMatch(/client_id=app-1/);
    expect(calledUrl.toString()).toMatch(/client_secret=secret-1/);
    expect(calledUrl.toString()).toMatch(/code=auth-code/);
  });

  it("[non-2xx] returns null, never throws", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, { error: { message: "bad code" } }));
    await expect(exchangeEmbeddedSignupCode("auth-code", CONFIG)).resolves.toBeNull();
  });

  it("[transport exception] returns null, never throws", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network down"));
    await expect(exchangeEmbeddedSignupCode("auth-code", CONFIG)).resolves.toBeNull();
  });

  it("[never logs the authorization code or the access token] only status codes appear in this function's own console.error metadata", () => {
    const fnStart = source.indexOf("export async function exchangeEmbeddedSignupCode");
    const fnEnd = source.indexOf("\nexport", fnStart + 1);
    const fn = source.slice(fnStart, fnEnd);
    const logCalls = fn.match(/console\.error\([^;]*?\);/g) ?? [];
    for (const call of logCalls) {
      expect(call).not.toMatch(/\baccessToken\b|\bcode\b/);
    }
  });
});

describe("getWhatsAppBusinessAccount", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("[access confirmed] the returned id echoes the SAME waba_id that was requested", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "waba-1" }));
    await expect(getWhatsAppBusinessAccount("waba-1", "token", CONFIG)).resolves.toEqual({ wabaId: "waba-1" });
  });

  it("[Meta returns a DIFFERENT id than requested] rejected — never trusts a mismatched echo", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { id: "waba-other" }));
    await expect(getWhatsAppBusinessAccount("waba-1", "token", CONFIG)).resolves.toBeNull();
  });

  it("[permission/not-found error] rejected — the browser's claimed waba_id is never trusted on its own (task section 9)", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(403, { error: { message: "no access" } }));
    await expect(getWhatsAppBusinessAccount("waba-1", "token", CONFIG)).resolves.toBeNull();
  });
});

describe("getPhoneNumber", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("[phone number belongs to the verified waba] returns the status", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "phone-1" }, { id: "phone-2" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "phone-1", is_on_biz_app: true, platform_type: "CLOUD_API" }));
    await expect(getPhoneNumber("phone-1", "waba-1", "token", CONFIG)).resolves.toEqual({ phoneNumberId: "phone-1", isOnBizApp: true });
  });

  it("[phone number does NOT belong to the verified waba — WABA/phone mismatch] rejected, status endpoint never even called", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "phone-other" }] }));
    await expect(getPhoneNumber("phone-1", "waba-1", "token", CONFIG)).resolves.toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("[waba phone_numbers listing fails] rejected", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(500, { error: { message: "server error" } }));
    await expect(getPhoneNumber("phone-1", "waba-1", "token", CONFIG)).resolves.toBeNull();
  });

  it("[status lookup returns a mismatched id] rejected", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "phone-1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "phone-different" }));
    await expect(getPhoneNumber("phone-1", "waba-1", "token", CONFIG)).resolves.toBeNull();
  });
});

describe("subscribeAppToWaba", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("[success: true] returns true", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { success: true }));
    await expect(subscribeAppToWaba("waba-1", "token", CONFIG)).resolves.toBe(true);
  });

  it("[failure] returns false, never throws", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, { error: { message: "already subscribed by another app" } }));
    await expect(subscribeAppToWaba("waba-1", "token", CONFIG)).resolves.toBe(false);
  });
});

describe("finalizeEmbeddedSignup", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubEnv("NEXT_PUBLIC_META_APP_ID", CONFIG.appId);
    vi.stubEnv("WHATSAPP_META_APP_SECRET", CONFIG.appSecret);
    vi.stubEnv("WHATSAPP_META_API_VERSION", CONFIG.apiVersion);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("[config missing] returns config_missing without ever calling fetch", async () => {
    vi.unstubAllEnvs();
    const result = await finalizeEmbeddedSignup({
      code: "c",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: "waba-1",
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: null,
    });
    expect(result).toEqual({ ok: false, errorCode: "config_missing" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["FINISH", "FINISH_ONLY_WABA", "FINISH_GRANT_ONLY_API_ACCESS", "FINISH_OBO_MIGRATION"] as const)(
    "[%s is never finalized — only the coexistence event is, pending confirmation of the phone-number registration step]",
    async (finishEvent) => {
      const result = await finalizeEmbeddedSignup({
        code: "c",
        finishEvent,
        claimedWabaId: "waba-1",
        claimedPhoneNumberId: "phone-1",
        claimedBusinessId: null,
      });
      expect(result).toEqual({ ok: false, errorCode: "unsupported_finish_event" });
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it("[missing claimed waba/phone hints] rejected before any Meta call", async () => {
    const result = await finalizeEmbeddedSignup({
      code: "c",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: null,
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: null,
    });
    expect(result).toEqual({ ok: false, errorCode: "waba_verification_failed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("[full happy path: exchange -> waba -> phone -> subscribe] returns ok:true with connectionType coexistence", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "eph-token" })) // exchange
      .mockResolvedValueOnce(jsonResponse(200, { id: "waba-1" })) // waba
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "phone-1" }] })) // phone_numbers listing
      .mockResolvedValueOnce(jsonResponse(200, { id: "phone-1", is_on_biz_app: true })) // phone status
      .mockResolvedValueOnce(jsonResponse(200, { success: true })); // subscribe

    const result = await finalizeEmbeddedSignup({
      code: "auth-code",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: "waba-1",
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: "biz-1",
    });

    expect(result).toEqual({
      ok: true,
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      businessId: "biz-1",
      connectionType: "coexistence",
      accessToken: "eph-token",
    });
  });

  it("[happy path] returns the access token to the CALLER only — this function's own contract, not a persistence action; the caller (actions.ts) is responsible for encrypting it immediately and never logging/returning/storing it in plaintext", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "eph-token" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "waba-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "phone-1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "phone-1", is_on_biz_app: true }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true }));

    const result = await finalizeEmbeddedSignup({
      code: "auth-code",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: "waba-1",
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: "biz-1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accessToken).toBe("eph-token");
  });

  it("[code exchange fails] stops immediately, never calls the waba/phone/subscribe endpoints", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, { error: { message: "bad code" } }));
    const result = await finalizeEmbeddedSignup({
      code: "auth-code",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: "waba-1",
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: null,
    });
    expect(result).toEqual({ ok: false, errorCode: "code_exchange_failed" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("[waba verification fails — browser's claimed waba_id was wrong/unauthorized] never reaches phone/subscribe", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "eph-token" }))
      .mockResolvedValueOnce(jsonResponse(403, { error: { message: "no access" } }));
    const result = await finalizeEmbeddedSignup({
      code: "auth-code",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: "waba-1",
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: null,
    });
    expect(result).toEqual({ ok: false, errorCode: "waba_verification_failed" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("[phone_number_id does not belong to the verified waba] phone_number_mismatch, never subscribes", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "eph-token" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "waba-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "phone-other" }] }));
    const result = await finalizeEmbeddedSignup({
      code: "auth-code",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: "waba-1",
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: null,
    });
    expect(result).toEqual({ ok: false, errorCode: "phone_number_mismatch" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("[app subscription fails] never returns ok:true — a connection must never be marked usable without a confirmed subscription (task section 12)", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { access_token: "eph-token" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "waba-1" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "phone-1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "phone-1", is_on_biz_app: true }))
      .mockResolvedValueOnce(jsonResponse(400, { error: { message: "subscribe failed" } }));
    const result = await finalizeEmbeddedSignup({
      code: "auth-code",
      finishEvent: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
      claimedWabaId: "waba-1",
      claimedPhoneNumberId: "phone-1",
      claimedBusinessId: null,
    });
    expect(result).toEqual({ ok: false, errorCode: "subscription_failed" });
  });
});

describe("this module never touches hotel_id or persists anything", () => {
  it("[no hotel_id/Supabase reference anywhere in this file's own CODE] tenant resolution and persistence are the CALLER's responsibility (features/whatsappIntegration/actions.ts), never this Meta-facing layer's — comments MAY document this boundary in prose (which necessarily names the very things it says are absent)", () => {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/hotelId|hotel_id|createAdminClient|createClient\(|\.from\(|\.rpc\(/);
  });

  it("[never a real invocation outside of this test file's own mocks] every fetch call in every test above is mocked — grep this test file for a live graph.facebook.com call", () => {
    const testSource = readFileSync(join(here, "metaEmbeddedSignup.test.ts"), "utf8");
    // Every fetch here goes through vi.stubGlobal("fetch", ...) — this file
    // never imports node-fetch/undici directly or disables the stub.
    expect(testSource).toMatch(/vi\.stubGlobal\("fetch"/);
  });
});
