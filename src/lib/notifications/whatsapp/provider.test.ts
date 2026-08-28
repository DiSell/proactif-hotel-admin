import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * getWhatsAppProvider() resolves either the Meta adapter (metaProvider.ts)
 * when fully configured, or a safe not-configured fallback otherwise — see
 * provider.ts. Mirrors src/lib/email/provider.test.ts's own structure
 * exactly. fetch is mocked here too — no real network call ever happens.
 */

const ORIGINAL_ENV = { ...process.env };

function clearWhatsAppEnv() {
  delete process.env.WHATSAPP_PROVIDER;
  delete process.env.WHATSAPP_META_ACCESS_TOKEN;
  delete process.env.WHATSAPP_META_PHONE_NUMBER_ID;
  delete process.env.WHATSAPP_META_VERIFY_TOKEN;
  delete process.env.WHATSAPP_META_APP_SECRET;
  delete process.env.WHATSAPP_META_API_VERSION;
}

function setFullWhatsAppEnv() {
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.WHATSAPP_META_ACCESS_TOKEN = "test-access-token";
  process.env.WHATSAPP_META_PHONE_NUMBER_ID = "123456";
  process.env.WHATSAPP_META_VERIFY_TOKEN = "test-verify-token";
  process.env.WHATSAPP_META_APP_SECRET = "test-app-secret";
  process.env.WHATSAPP_META_API_VERSION = "v21.0";
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("getWhatsAppProvider — not configured", () => {
  it("[always returns a provider, never null/undefined]", async () => {
    clearWhatsAppEnv();
    const { getWhatsAppProvider } = await import("./provider");
    expect(getWhatsAppProvider()).toBeTruthy();
  });

  it("[sendTemplateMessage resolves provider_not_configured, never throws]", async () => {
    clearWhatsAppEnv();
    const { getWhatsAppProvider } = await import("./provider");

    const result = await getWhatsAppProvider().sendTemplateMessage({
      toE164: "+33612345678",
      templateName: "t",
      languageCode: "fr",
      bodyParams: [],
      buttons: [],
    });

    expect(result).toEqual({ ok: false, error: "provider_not_configured" });
  });

  it("[never touches the network]", async () => {
    clearWhatsAppEnv();
    const fetchSpy = vi.spyOn(global, "fetch");
    const { getWhatsAppProvider } = await import("./provider");

    await getWhatsAppProvider().sendTemplateMessage({ toE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [], buttons: [] });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("[webhook challenge always refused]", async () => {
    clearWhatsAppEnv();
    const { getWhatsAppProvider } = await import("./provider");

    expect(getWhatsAppProvider().verifyWebhookChallenge({ mode: "subscribe", token: "anything", challenge: "c" })).toBeNull();
  });

  it("[webhook payload always refused]", async () => {
    clearWhatsAppEnv();
    const { getWhatsAppProvider } = await import("./provider");

    expect(getWhatsAppProvider().parseWebhookPayload("{}", "sha256=anything")).toEqual({ ok: false, error: "invalid_signature" });
  });

  it("[logged, nothing sensitive to leak]", async () => {
    clearWhatsAppEnv();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getWhatsAppProvider } = await import("./provider");

    await getWhatsAppProvider().sendTemplateMessage({ toE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [], buttons: [] });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/no provider configured/i));
  });
});

describe("getWhatsAppProvider — Meta fully configured", () => {
  it("[uses the Meta provider, not the not-configured fallback]", async () => {
    setFullWhatsAppEnv();
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 }));
    const { getWhatsAppProvider } = await import("./provider");

    const result = await getWhatsAppProvider().sendTemplateMessage({
      toE164: "+33612345678",
      templateName: "t",
      languageCode: "fr",
      bodyParams: [],
      buttons: [],
    });

    expect(result).not.toEqual({ ok: false, error: "provider_not_configured" });
  });

  it("[partial config still falls back to not-configured]", async () => {
    setFullWhatsAppEnv();
    delete process.env.WHATSAPP_META_APP_SECRET;
    const { getWhatsAppProvider } = await import("./provider");

    const result = await getWhatsAppProvider().sendTemplateMessage({
      toE164: "+33612345678",
      templateName: "t",
      languageCode: "fr",
      bodyParams: [],
      buttons: [],
    });

    expect(result).toEqual({ ok: false, error: "provider_not_configured" });
  });
});
