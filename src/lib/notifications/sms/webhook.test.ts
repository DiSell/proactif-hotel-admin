import { describe, expect, it } from "vitest";
import Twilio from "twilio";
import { handleInboundSms, resolvePublicRequestUrl } from "./webhook";

describe("handleInboundSms — requires a valid signature before extracting anything", () => {
  const authToken = "the-real-auth-token";
  const url = "https://example.com/api/webhooks/twilio/sms";
  const params = { MessageSid: "SM123", From: "+33612345678", To: "+15005550006", Body: "1 ABC7" };

  function sign(u: string, p: Record<string, string>): string {
    return Twilio.getExpectedTwilioSignature(authToken, u, p);
  }

  it("[valid signature] extracts MessageSid/From/To/Body verbatim", () => {
    const outcome = handleInboundSms(url, sign(url, params), params, { signatureConfig: { authToken } });

    expect(outcome).toEqual({
      ok: true,
      fields: { messageSid: "SM123", from: "+33612345678", to: "+15005550006", body: "1 ABC7" },
    });
  });

  it("[missing signature header] rejected as invalid_signature, fields never extracted", () => {
    const outcome = handleInboundSms(url, null, params, { signatureConfig: { authToken } });

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("[wrong signature] rejected as invalid_signature", () => {
    const outcome = handleInboundSms(url, "wrong-signature", params, { signatureConfig: { authToken } });

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("[signatureConfig explicitly null — not configured] rejected regardless of the signature supplied", () => {
    const outcome = handleInboundSms(url, sign(url, params), params, { signatureConfig: null });

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("[no signatureConfig passed — reads from the environment] falls back to readTwilioWebhookSignatureConfigFromEnv, which is unset in tests, so rejected", () => {
    const outcome = handleInboundSms(url, sign(url, params), params);

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("[missing fields in params] extracts empty strings rather than throwing", () => {
    const sparseParams = { MessageSid: "SM123" };
    const outcome = handleInboundSms(url, sign(url, sparseParams), sparseParams, { signatureConfig: { authToken } });

    expect(outcome).toEqual({
      ok: true,
      fields: { messageSid: "SM123", from: "", to: "", body: "" },
    });
  });

  it("[body content is never inspected/parsed here] a digit+code Body passes through completely untouched — no business logic, no correlation lookup, no RPC (PHASE 1 scope)", () => {
    const p = { ...params, Body: "3 XY9Z1" };
    const outcome = handleInboundSms(url, sign(url, p), p, { signatureConfig: { authToken } });

    expect(outcome).toEqual({ ok: true, fields: { messageSid: "SM123", from: "+33612345678", to: "+15005550006", body: "3 XY9Z1" } });
  });
});

describe("resolvePublicRequestUrl — Render/reverse-proxy scheme and host correction", () => {
  it("[no forwarded headers] returns request.url unchanged", () => {
    const request = new Request("https://example.com/api/webhooks/twilio/sms?x=1");
    expect(resolvePublicRequestUrl(request)).toBe("https://example.com/api/webhooks/twilio/sms?x=1");
  });

  it("[proxy terminates TLS — internal http, X-Forwarded-Proto: https] corrects the scheme to https", () => {
    const request = new Request("http://internal-host/api/webhooks/twilio/sms", {
      headers: { "x-forwarded-proto": "https", host: "sms.proactifsystem.fr" },
    });

    expect(resolvePublicRequestUrl(request)).toBe("https://sms.proactifsystem.fr/api/webhooks/twilio/sms");
  });

  it("[X-Forwarded-Host present] overrides the host Twilio actually called, distinct from the internal Host header", () => {
    const request = new Request("http://internal-host/api/webhooks/twilio/sms", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "sms.proactifsystem.fr", host: "internal-host" },
    });

    expect(resolvePublicRequestUrl(request)).toBe("https://sms.proactifsystem.fr/api/webhooks/twilio/sms");
  });

  it("[multiple comma-separated values — chained proxies] uses only the first (client-facing) value", () => {
    const request = new Request("http://internal-host/api/webhooks/twilio/sms", {
      headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": "sms.proactifsystem.fr, internal-lb" },
    });

    expect(resolvePublicRequestUrl(request)).toBe("https://sms.proactifsystem.fr/api/webhooks/twilio/sms");
  });

  it("[query string preserved] path and query survive the scheme/host correction", () => {
    const request = new Request("http://internal-host/api/webhooks/twilio/sms?foo=bar", {
      headers: { "x-forwarded-proto": "https", host: "sms.proactifsystem.fr" },
    });

    expect(resolvePublicRequestUrl(request)).toBe("https://sms.proactifsystem.fr/api/webhooks/twilio/sms?foo=bar");
  });

  it("[end-to-end proof] a signature computed against the CORRECTED public URL validates successfully, while the raw internal URL would not", () => {
    const authToken = "proxy-test-token";
    const params = { MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 ABC7" };
    const request = new Request("http://internal-host/api/webhooks/twilio/sms", {
      headers: { "x-forwarded-proto": "https", host: "sms.proactifsystem.fr" },
    });

    const publicUrl = resolvePublicRequestUrl(request);
    const signature = Twilio.getExpectedTwilioSignature(authToken, publicUrl, params);

    const outcomeWithCorrectedUrl = handleInboundSms(publicUrl, signature, params, { signatureConfig: { authToken } });
    expect(outcomeWithCorrectedUrl.ok).toBe(true);

    const outcomeWithRawInternalUrl = handleInboundSms(request.url, signature, params, { signatureConfig: { authToken } });
    expect(outcomeWithRawInternalUrl).toEqual({ ok: false, reason: "invalid_signature" });
  });
});
