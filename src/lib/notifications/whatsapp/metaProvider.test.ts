import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";

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

describe("readMetaConfigFromEnv", () => {
  it("[fully configured] returns the config object", async () => {
    setFullWhatsAppEnv();
    const { readMetaConfigFromEnv } = await import("./metaProvider");
    expect(readMetaConfigFromEnv()).toEqual({
      accessToken: "test-access-token",
      phoneNumberId: "123456",
      verifyToken: "test-verify-token",
      appSecret: "test-app-secret",
      apiVersion: "v21.0",
    });
  });

  it("[WHATSAPP_PROVIDER not \"meta\"] returns null even if every other value is set", async () => {
    setFullWhatsAppEnv();
    process.env.WHATSAPP_PROVIDER = "twilio";
    const { readMetaConfigFromEnv } = await import("./metaProvider");
    expect(readMetaConfigFromEnv()).toBeNull();
  });

  it.each(["WHATSAPP_META_ACCESS_TOKEN", "WHATSAPP_META_PHONE_NUMBER_ID", "WHATSAPP_META_VERIFY_TOKEN", "WHATSAPP_META_APP_SECRET", "WHATSAPP_META_API_VERSION"])(
    "[%s missing] returns null",
    async (missingVar) => {
      setFullWhatsAppEnv();
      delete process.env[missingVar];
      const { readMetaConfigFromEnv } = await import("./metaProvider");
      expect(readMetaConfigFromEnv()).toBeNull();
    }
  );

  it("[nothing set] returns null", async () => {
    clearWhatsAppEnv();
    const { readMetaConfigFromEnv } = await import("./metaProvider");
    expect(readMetaConfigFromEnv()).toBeNull();
  });
});

describe("readMetaWebhookVerifyConfigFromEnv / verifyMetaWebhookChallenge — GET handshake requires ONLY the verify token", () => {
  it("[Render's real current state: only WHATSAPP_PROVIDER + WHATSAPP_META_VERIFY_TOKEN set] returns a config — this is the exact bug scenario", async () => {
    clearWhatsAppEnv();
    process.env.WHATSAPP_PROVIDER = "meta";
    process.env.WHATSAPP_META_VERIFY_TOKEN = "render-verify-token";
    const { readMetaWebhookVerifyConfigFromEnv } = await import("./metaProvider");

    expect(readMetaWebhookVerifyConfigFromEnv()).toEqual({ verifyToken: "render-verify-token" });
  });

  it.each(["WHATSAPP_META_ACCESS_TOKEN", "WHATSAPP_META_PHONE_NUMBER_ID", "WHATSAPP_META_APP_SECRET", "WHATSAPP_META_API_VERSION"])(
    "[%s absent] never prevents the GET handshake from being considered configured",
    async (unrelatedVar) => {
      clearWhatsAppEnv();
      process.env.WHATSAPP_PROVIDER = "meta";
      process.env.WHATSAPP_META_VERIFY_TOKEN = "render-verify-token";
      delete process.env[unrelatedVar];
      const { readMetaWebhookVerifyConfigFromEnv } = await import("./metaProvider");

      expect(readMetaWebhookVerifyConfigFromEnv()).toEqual({ verifyToken: "render-verify-token" });
    }
  );

  it("[WHATSAPP_PARTNER_REQUEST_TEMPLATE absent] never referenced by this reader at all — the send-side template is a separate concern (features/rag's own sendPartnerRequest.ts)", async () => {
    clearWhatsAppEnv();
    delete process.env.WHATSAPP_PARTNER_REQUEST_TEMPLATE;
    process.env.WHATSAPP_PROVIDER = "meta";
    process.env.WHATSAPP_META_VERIFY_TOKEN = "render-verify-token";
    const { readMetaWebhookVerifyConfigFromEnv } = await import("./metaProvider");

    expect(readMetaWebhookVerifyConfigFromEnv()).toEqual({ verifyToken: "render-verify-token" });
  });

  it("[WHATSAPP_META_VERIFY_TOKEN missing] returns null", async () => {
    clearWhatsAppEnv();
    process.env.WHATSAPP_PROVIDER = "meta";
    const { readMetaWebhookVerifyConfigFromEnv } = await import("./metaProvider");

    expect(readMetaWebhookVerifyConfigFromEnv()).toBeNull();
  });

  it("[WHATSAPP_PROVIDER not \"meta\"] returns null even with a verify token set", async () => {
    clearWhatsAppEnv();
    process.env.WHATSAPP_PROVIDER = "twilio";
    process.env.WHATSAPP_META_VERIFY_TOKEN = "render-verify-token";
    const { readMetaWebhookVerifyConfigFromEnv } = await import("./metaProvider");

    expect(readMetaWebhookVerifyConfigFromEnv()).toBeNull();
  });

  it("[correct token] verifyMetaWebhookChallenge returns the challenge — this is the 200 response Meta expects", async () => {
    const { verifyMetaWebhookChallenge } = await import("./metaProvider");

    const result = verifyMetaWebhookChallenge({ mode: "subscribe", token: "render-verify-token", challenge: "12345" }, { verifyToken: "render-verify-token" });

    expect(result).toBe("12345");
  });

  it("[wrong token] verifyMetaWebhookChallenge returns null — this is the 403 response", async () => {
    const { verifyMetaWebhookChallenge } = await import("./metaProvider");

    const result = verifyMetaWebhookChallenge({ mode: "subscribe", token: "wrong", challenge: "12345" }, { verifyToken: "render-verify-token" });

    expect(result).toBeNull();
  });

  it("[config null — not configured] returns null regardless of the token supplied", async () => {
    const { verifyMetaWebhookChallenge } = await import("./metaProvider");

    expect(verifyMetaWebhookChallenge({ mode: "subscribe", token: "anything", challenge: "c" }, null)).toBeNull();
  });

  it("[no token ever logged] neither the reader nor the verifier calls console.error at all", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.WHATSAPP_PROVIDER = "meta";
    process.env.WHATSAPP_META_VERIFY_TOKEN = "render-verify-token";
    const { readMetaWebhookVerifyConfigFromEnv, verifyMetaWebhookChallenge } = await import("./metaProvider");

    verifyMetaWebhookChallenge({ mode: "subscribe", token: "wrong", challenge: "c" }, readMetaWebhookVerifyConfigFromEnv());

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe("readMetaWebhookSignatureConfigFromEnv / parseMetaWebhookPayload — POST verification requires APP_SECRET, NEVER made optional", () => {
  it("[only PROVIDER + APP_SECRET set] returns a config — decoupled from ACCESS_TOKEN/PHONE_NUMBER_ID/API_VERSION/VERIFY_TOKEN", async () => {
    clearWhatsAppEnv();
    process.env.WHATSAPP_PROVIDER = "meta";
    process.env.WHATSAPP_META_APP_SECRET = "render-app-secret";
    const { readMetaWebhookSignatureConfigFromEnv } = await import("./metaProvider");

    expect(readMetaWebhookSignatureConfigFromEnv()).toEqual({ appSecret: "render-app-secret" });
  });

  it("[WHATSAPP_META_APP_SECRET missing] returns null — POST verification is never satisfiable without it", async () => {
    clearWhatsAppEnv();
    process.env.WHATSAPP_PROVIDER = "meta";
    const { readMetaWebhookSignatureConfigFromEnv } = await import("./metaProvider");

    expect(readMetaWebhookSignatureConfigFromEnv()).toBeNull();
  });

  it("[config null] parseMetaWebhookPayload rejects as invalid_signature regardless of the header supplied — APP_SECRET can never be bypassed", async () => {
    const { parseMetaWebhookPayload } = await import("./metaProvider");

    expect(parseMetaWebhookPayload("{}", "sha256=whatever", null)).toEqual({ ok: false, error: "invalid_signature" });
  });

  it("[valid signature with a real config] parses successfully", async () => {
    const { parseMetaWebhookPayload } = await import("./metaProvider");
    const appSecret = "render-app-secret";
    const rawBody = JSON.stringify({ entry: [] });
    const signature = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;

    expect(parseMetaWebhookPayload(rawBody, signature, { appSecret })).toEqual({ ok: true, events: [] });
  });
});

describe("createMetaWhatsAppProvider — sendTemplateMessage (fetch mocked, NEVER a real network call)", () => {
  const message = { toE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [], buttons: [] };
  const sendConfig = { accessToken: "t", phoneNumberId: "123", verifyToken: "v", appSecret: "s", apiVersion: "v21.0" };
  it("[success] returns providerMessageId from the mocked response", async () => {
    const fetchMock = vi.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.test123" }] }), { status: 200 })
    );
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider({
      accessToken: "token",
      phoneNumberId: "123",
      verifyToken: "v",
      appSecret: "s",
      apiVersion: "v21.0",
    });

    const result = await provider.sendTemplateMessage({
      toE164: "+33612345678",
      templateName: "partner_request_v1",
      languageCode: "fr",
      bodyParams: ["Hôtel Test"],
      buttons: [{ label: "Accepter", payload: "signed-token" }],
    });

    expect(result).toEqual({ ok: true, providerMessageId: "wamid.test123" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("graph.facebook.com");
    expect(fetchMock.mock.calls[0][0]).toContain("v21.0");
    expect(fetchMock.mock.calls[0][0]).toContain("123");
  });

  it("[request never contains the raw phone number with a leading +] Meta's API expects the number without the plus sign", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 }));
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider({ accessToken: "t", phoneNumberId: "123", verifyToken: "v", appSecret: "s", apiVersion: "v21.0" });

    await provider.sendTemplateMessage({ toE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [], buttons: [] });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.to).toBe("33612345678");
  });

  it("[Meta rejects the request] returns { ok: false, error: \"provider_error\" }, never throws, never logs the response body", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: "Invalid parameter" } }), { status: 400 }));
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider({ accessToken: "t", phoneNumberId: "123", verifyToken: "v", appSecret: "s", apiVersion: "v21.0" });

    const result = await provider.sendTemplateMessage({ toE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [], buttons: [] });

    expect(result).toEqual({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    for (const call of consoleErrorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/33612345678|Invalid parameter/);
    }
  });

  it("[network throws — no HTTP response ever received] resolves { ok: false, error: \"provider_unknown\" }, never \"provider_error\", never rejects", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider({ accessToken: "t", phoneNumberId: "123", verifyToken: "v", appSecret: "s", apiVersion: "v21.0" });

    await expect(
      provider.sendTemplateMessage({ toE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [], buttons: [] })
    ).resolves.toEqual({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
  });

  it("[timeout via AbortError — same ambiguous treatment as any other thrown exception] resolves provider_unknown", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.spyOn(global, "fetch").mockRejectedValue(abortError);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider({ accessToken: "t", phoneNumberId: "123", verifyToken: "v", appSecret: "s", apiVersion: "v21.0" });

    const result = await provider.sendTemplateMessage({ toE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [], buttons: [] });

    expect(result).toEqual({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
  });

  it.each([[200, {}], [200, { messages: [] }], [200, { messages: [{ id: "" }] }], [200, { messages: [{ id: "not-a-wamid" }] }]])(
    "[HTTP %s without usable message id] is ambiguous", async (status, body) => {
      vi.spyOn(global, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { createMetaWhatsAppProvider } = await import("./metaProvider");
      await expect(createMetaWhatsAppProvider(sendConfig).sendTemplateMessage(message)).resolves.toEqual({
        ok: false, error: "provider_unknown", attempted: true, certainty: "unknown",
      });
    }
  );

  it.each([400, 401, 403, 404, 429])("[HTTP %s rejection] is certainly not sent", async (status) => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("not-json", { status }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    await expect(createMetaWhatsAppProvider(sendConfig).sendTemplateMessage(message)).resolves.toEqual({
      ok: false, error: "provider_error", attempted: true, certainty: "not_sent",
    });
  });

  it.each([500, 502, 503, 504])("[HTTP %s] is ambiguous", async (status) => {
    vi.spyOn(global, "fetch").mockResolvedValue(new Response("not-json", { status }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    await expect(createMetaWhatsAppProvider(sendConfig).sendTemplateMessage(message)).resolves.toEqual({
      ok: false, error: "provider_unknown", attempted: true, certainty: "unknown",
    });
  });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"])("[%s before connection] is certainly not sent", async (code) => {
    vi.spyOn(global, "fetch").mockRejectedValue(Object.assign(new Error("sensitive +33612345678"), { cause: { code } }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    await expect(createMetaWhatsAppProvider(sendConfig).sendTemplateMessage(message)).resolves.toEqual({
      ok: false, error: "provider_error", attempted: true, certainty: "not_sent",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("33612345678");
  });

  it.each(["ECONNRESET", "EPIPE"])("[%s after possible write] is ambiguous", async (code) => {
    vi.spyOn(global, "fetch").mockRejectedValue(Object.assign(new Error("private provider body"), { cause: { code } }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    await expect(createMetaWhatsAppProvider(sendConfig).sendTemplateMessage(message)).resolves.toEqual({
      ok: false, error: "provider_unknown", attempted: true, certainty: "unknown",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private provider body");
  });
});

describe("createMetaWhatsAppProvider — verifyWebhookChallenge", () => {
  const config = { accessToken: "t", phoneNumberId: "123", verifyToken: "correct-verify-token", appSecret: "s", apiVersion: "v21.0" };

  it("[valid handshake] returns the challenge string", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);

    expect(provider.verifyWebhookChallenge({ mode: "subscribe", token: "correct-verify-token", challenge: "the-challenge" })).toBe("the-challenge");
  });

  it("[wrong verify token] returns null", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);

    expect(provider.verifyWebhookChallenge({ mode: "subscribe", token: "wrong-token", challenge: "the-challenge" })).toBeNull();
  });

  it("[wrong mode] returns null even with the correct token", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);

    expect(provider.verifyWebhookChallenge({ mode: "unsubscribe", token: "correct-verify-token", challenge: "the-challenge" })).toBeNull();
  });

  it("[missing params] returns null", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);

    expect(provider.verifyWebhookChallenge({ mode: null, token: null, challenge: null })).toBeNull();
  });
});

describe("createMetaWhatsAppProvider — parseWebhookPayload", () => {
  const config = { accessToken: "t", phoneNumberId: "123", verifyToken: "v", appSecret: "webhook-secret", apiVersion: "v21.0" };

  function sign(rawBody: string): string {
    return `sha256=${createHmac("sha256", config.appSecret).update(rawBody).digest("hex")}`;
  }

  it("[missing signature header] rejected as invalid_signature", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);

    expect(provider.parseWebhookPayload("{}", null)).toEqual({ ok: false, error: "invalid_signature" });
  });

  it("[wrong signature] rejected as invalid_signature", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);

    expect(provider.parseWebhookPayload("{}", "sha256=deadbeef")).toEqual({ ok: false, error: "invalid_signature" });
  });

  it("[valid signature, malformed JSON] rejected as malformed_payload", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);
    const rawBody = "{not valid json";

    expect(provider.parseWebhookPayload(rawBody, sign(rawBody))).toEqual({ ok: false, error: "malformed_payload" });
  });

  it("[valid signature, unrecognized top-level shape] rejected as malformed_payload", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);
    const rawBody = JSON.stringify({ not_entry: [] });

    expect(provider.parseWebhookPayload(rawBody, sign(rawBody))).toEqual({ ok: false, error: "malformed_payload" });
  });

  it("[valid signature, button reply] extracts the button payload and sender", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);
    const rawBody = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "33612345678", button: { payload: "signed-token-abc" } }] } }] }],
    });

    const result = provider.parseWebhookPayload(rawBody, sign(rawBody));

    expect(result).toEqual({ ok: true, events: [{ type: "button_reply", payload: "signed-token-abc", fromE164: "+33612345678" }] });
  });

  it("[valid signature, free-text message] parses to unhandled, never guessed at", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);
    const rawBody = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "33612345678", text: { body: "oui je confirme" } }] } }] }],
    });

    const result = provider.parseWebhookPayload(rawBody, sign(rawBody));

    expect(result).toEqual({ ok: true, events: [{ type: "unhandled" }] });
  });

  it("[valid signature, no messages array — e.g. a status callback] resolves ok with zero events, never throws", async () => {
    const { createMetaWhatsAppProvider } = await import("./metaProvider");
    const provider = createMetaWhatsAppProvider(config);
    const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }] });

    const result = provider.parseWebhookPayload(rawBody, sign(rawBody));

    expect(result).toEqual({ ok: true, events: [] });
  });
});
