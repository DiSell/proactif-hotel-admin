import { afterEach, describe, expect, it, vi } from "vitest";
import Twilio from "twilio";
import { createTwilioSmsWebhookHandlers, type TwilioSmsWebhookDeps } from "./route";
import type { InboundSmsOutcome } from "@/lib/notifications/sms/webhook";

function makeDeps(overrides: Partial<TwilioSmsWebhookDeps> = {}): TwilioSmsWebhookDeps {
  return {
    handleInboundSms: vi.fn<() => InboundSmsOutcome>(() => ({ ok: false, reason: "invalid_signature" })),
    ...overrides,
  };
}

function postRequest(params: Record<string, string>, signature: string | null, url = "https://example.com/api/webhooks/twilio/sms") {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (signature) headers.set("x-twilio-signature", signature);
  const body = new URLSearchParams(params).toString();
  return new Request(url, { method: "POST", body, headers });
}

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("POST /api/webhooks/twilio/sms — signature gate", () => {
  it("[invalid/missing signature] returns 403, no TwiML body", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: false, reason: "invalid_signature" }));
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1" }, null));

    expect(response.status).toBe(403);
    expect(handleInboundSms).toHaveBeenCalledTimes(1);
  });

  it("[valid signature] returns 200 with an empty TwiML <Response/> body, Content-Type text/xml", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({
      ok: true,
      fields: { messageSid: "SM1", from: "+33612345678", to: "+15005550006", body: "1 ABC7" },
    }));
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 ABC7" }, "sha1=good"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/text\/xml/);
    const text = await response.text();
    expect(text).toContain("<Response");
    // Built via the official SDK's MessagingResponse, never a hand-written
    // string — an empty response, never a <Message> node (which would send
    // an automatic reply just because the webhook was reached).
    expect(text).not.toContain("<Message");
  });

  it("[form-urlencoded body parsed correctly] MessageSid/From/To/Body reach handleInboundSms as an exact params object", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: false, reason: "invalid_signature" }));
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms }));

    await POST(postRequest({ MessageSid: "SM42", From: "+33611112222", To: "+15005550006", Body: "2 XYZ9", ExtraField: "ignored-by-us-but-included" }, "sha1=whatever"));

    expect(handleInboundSms).toHaveBeenCalledWith(
      "https://example.com/api/webhooks/twilio/sms",
      "sha1=whatever",
      { MessageSid: "SM42", From: "+33611112222", To: "+15005550006", Body: "2 XYZ9", ExtraField: "ignored-by-us-but-included" }
    );
  });

  it("[no business action triggered on a valid signature] handleInboundSms is the ONLY dependency called — no import of a delivery service, RPC wrapper, or Supabase admin client anywhere in the route's source (PHASE 1 scope)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "route.ts"), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => line.trim().startsWith("import"))
      .join("\n");

    expect(importLines).not.toMatch(/deliveryService|createAdminClient|\.rpc\(|supabase/i);
  });

  it("[X-Forwarded-Proto behind a reverse proxy — real end-to-end pipeline, no deps override] a signature computed against the public https URL validates through the real route", async () => {
    process.env.TWILIO_AUTH_TOKEN = "real-pipeline-token";
    const { POST } = createTwilioSmsWebhookHandlers();
    const params = { MessageSid: "SM99", From: "+33612345678", To: "+15005550006", Body: "1 ABC7" };
    const publicUrl = "https://sms.proactifsystem.fr/api/webhooks/twilio/sms";
    const signature = Twilio.getExpectedTwilioSignature("real-pipeline-token", publicUrl, params);

    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
      "x-forwarded-proto": "https",
      host: "sms.proactifsystem.fr",
    });
    const request = new Request("http://internal-host/api/webhooks/twilio/sms", {
      method: "POST",
      body: new URLSearchParams(params).toString(),
      headers,
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
  });

  it("[real end-to-end pipeline, wrong signature] rejected with 403 even with a correctly-reconstructed public URL", async () => {
    process.env.TWILIO_AUTH_TOKEN = "real-pipeline-token";
    const { POST } = createTwilioSmsWebhookHandlers();
    const params = { MessageSid: "SM99", From: "+33612345678", To: "+15005550006", Body: "1 ABC7" };

    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "definitely-wrong",
      "x-forwarded-proto": "https",
      host: "sms.proactifsystem.fr",
    });
    const request = new Request("http://internal-host/api/webhooks/twilio/sms", {
      method: "POST",
      body: new URLSearchParams(params).toString(),
      headers,
    });

    const response = await POST(request);

    expect(response.status).toBe(403);
  });
});
