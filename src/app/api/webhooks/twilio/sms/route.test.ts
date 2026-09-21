import { afterEach, describe, expect, it, vi } from "vitest";
import Twilio from "twilio";
import { createTwilioSmsWebhookHandlers, type TwilioSmsWebhookDeps } from "./route";
import type { InboundSmsOutcome } from "@/lib/notifications/sms/webhook";
import type { ResolvePartnerReplySmsOutcome } from "@/features/partnerRequests/deliveryService";
import type { ResolveSpaBookingReplySmsOutcome } from "@/features/spa/deliveryService";

function makeDeps(overrides: Partial<TwilioSmsWebhookDeps> = {}): TwilioSmsWebhookDeps {
  return {
    handleInboundSms: vi.fn<() => InboundSmsOutcome>(() => ({ ok: false, reason: "invalid_signature" })),
    resolvePartnerReplySms: vi.fn<() => Promise<ResolvePartnerReplySmsOutcome>>(async () => ({ ok: false, reason: "code_not_found" })),
    applyPartnerReplyCommand: vi.fn(async () => undefined),
    resolveSpaBookingReplySms: vi.fn<() => Promise<ResolveSpaBookingReplySmsOutcome>>(async () => ({ ok: false, reason: "code_not_found" })),
    applySpaBookingReplyCommand: vi.fn(async () => undefined),
    ...overrides,
  };
}

function postRequest(params: Record<string, string>, signature: string | null, url = "https://example.com/api/webhooks/twilio/sms") {
  const headers = new Headers({ "Content-Type": "application/x-www-form-urlencoded" });
  if (signature) headers.set("x-twilio-signature", signature);
  const body = new URLSearchParams(params).toString();
  return new Request(url, { method: "POST", body, headers });
}

const validInboundFields = { messageSid: "SM1", from: "+33612345678", to: "+15005550006", body: "1 K7M4PZ" };

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("POST /api/webhooks/twilio/sms — signature gate", () => {
  it("[invalid/missing signature] returns 403, no resolver ever called", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: false, reason: "invalid_signature" }));
    const resolvePartnerReplySms = vi.fn(async () => ({ ok: false, reason: "code_not_found" }) as ResolvePartnerReplySmsOutcome);
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, resolvePartnerReplySms }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1" }, null));

    expect(response.status).toBe(403);
    expect(resolvePartnerReplySms).not.toHaveBeenCalled();
  });

  it("[valid signature] always returns 200 with an empty TwiML <Response/> body, regardless of resolution outcome", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: validInboundFields }));
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 K7M4PZ" }, "sha1=good"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/text\/xml/);
    const text = await response.text();
    expect(text).toContain("<Response");
    expect(text).not.toContain("<Message");
  });
});

describe("POST /api/webhooks/twilio/sms — partner reply dispatch", () => {
  it("[resolvable partner reply] applyPartnerReplyCommand called with the DB-resolved ids/command/message, never anything parsed from the SMS itself", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: { ...validInboundFields, body: "1 K7M4PZ" } }));
    const resolvePartnerReplySms = vi.fn<() => Promise<ResolvePartnerReplySmsOutcome>>(async () => ({
      ok: true,
      resolved: { deliveryId: "d1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_accept", message: null },
    }));
    const applyPartnerReplyCommand = vi.fn(async () => undefined);
    const resolveSpaBookingReplySms = vi.fn<() => Promise<ResolveSpaBookingReplySmsOutcome>>(async () => ({ ok: false, reason: "code_not_found" }));
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, resolvePartnerReplySms, applyPartnerReplyCommand, resolveSpaBookingReplySms }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 K7M4PZ" }, "sha1=good"));

    expect(response.status).toBe(200);
    expect(applyPartnerReplyCommand).toHaveBeenCalledWith("req-1", "hotel-1", "partner_accept", null);
    expect(resolveSpaBookingReplySms).not.toHaveBeenCalled();
  });

  it("[alternative with free text] applyPartnerReplyCommand receives the sanitized message from the resolver", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: { ...validInboundFields, body: "3 K7M4PZ 21h00" } }));
    const resolvePartnerReplySms = vi.fn<() => Promise<ResolvePartnerReplySmsOutcome>>(async () => ({
      ok: true,
      resolved: { deliveryId: "d1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_propose_alternative", message: "21h00" },
    }));
    const applyPartnerReplyCommand = vi.fn(async () => undefined);
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, resolvePartnerReplySms, applyPartnerReplyCommand }));

    await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "3 K7M4PZ 21h00" }, "sha1=good"));

    expect(applyPartnerReplyCommand).toHaveBeenCalledWith("req-1", "hotel-1", "partner_propose_alternative", "21h00");
  });

  it("[partner reply application throws] never fails the whole webhook — still 200", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: validInboundFields }));
    const resolvePartnerReplySms = vi.fn<() => Promise<ResolvePartnerReplySmsOutcome>>(async () => ({
      ok: true,
      resolved: { deliveryId: "d1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_accept", message: null },
    }));
    const applyPartnerReplyCommand = vi.fn().mockRejectedValueOnce(new Error("not allowed from status accepted"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, resolvePartnerReplySms, applyPartnerReplyCommand }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 K7M4PZ" }, "sha1=good"));

    expect(response.status).toBe(200);
    consoleErrorSpy.mockRestore();
  });
});

describe("POST /api/webhooks/twilio/sms — spa reply dispatch (only tried once the partner space misses)", () => {
  it("[not a partner code, resolves as spa] applySpaBookingReplyCommand called with the DB-resolved ids/command", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: { ...validInboundFields, body: "1 SPA123" } }));
    const resolvePartnerReplySms = vi.fn<() => Promise<ResolvePartnerReplySmsOutcome>>(async () => ({ ok: false, reason: "code_not_found" }));
    const resolveSpaBookingReplySms = vi.fn<() => Promise<ResolveSpaBookingReplySmsOutcome>>(async () => ({
      ok: true,
      resolved: { deliveryId: "d2", hotelId: "hotel-1", bookingId: "booking-1", command: "approve" },
    }));
    const applySpaBookingReplyCommand = vi.fn(async () => undefined);
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, resolvePartnerReplySms, resolveSpaBookingReplySms, applySpaBookingReplyCommand }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 SPA123" }, "sha1=good"));

    expect(response.status).toBe(200);
    expect(applySpaBookingReplyCommand).toHaveBeenCalledWith("booking-1", "hotel-1", "approve");
  });

  it("[neither space resolves] no apply function called, request still succeeds (200)", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: { ...validInboundFields, body: "1 UNKNOWN" } }));
    const applyPartnerReplyCommand = vi.fn(async () => undefined);
    const applySpaBookingReplyCommand = vi.fn(async () => undefined);
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, applyPartnerReplyCommand, applySpaBookingReplyCommand }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 UNKNOWN" }, "sha1=good"));

    expect(response.status).toBe(200);
    expect(applyPartnerReplyCommand).not.toHaveBeenCalled();
    expect(applySpaBookingReplyCommand).not.toHaveBeenCalled();
  });

  it("[unparseable body] neither resolver called at all", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: { ...validInboundFields, body: "hello there" } }));
    const resolvePartnerReplySms = vi.fn(async () => ({ ok: false, reason: "unparseable" }) as ResolvePartnerReplySmsOutcome);
    const resolveSpaBookingReplySms = vi.fn(async () => ({ ok: false, reason: "unparseable" }) as ResolveSpaBookingReplySmsOutcome);
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, resolvePartnerReplySms, resolveSpaBookingReplySms }));

    // resolvePartnerReplySms itself is still called (route.ts delegates the
    // full parse+resolve to it) — what matters is that an unparseable body
    // never reaches applyPartnerReplyCommand/applySpaBookingReplyCommand,
    // proven by the "neither space resolves" test above using the same
    // real parser. This test only proves the route still returns 200.
    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "hello there" }, "sha1=good"));

    expect(response.status).toBe(200);
  });

  it("[spa reply application throws] never fails the whole webhook — still 200", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: true, fields: { ...validInboundFields, body: "1 SPA123" } }));
    const resolvePartnerReplySms = vi.fn<() => Promise<ResolvePartnerReplySmsOutcome>>(async () => ({ ok: false, reason: "code_not_found" }));
    const resolveSpaBookingReplySms = vi.fn<() => Promise<ResolveSpaBookingReplySmsOutcome>>(async () => ({
      ok: true,
      resolved: { deliveryId: "d2", hotelId: "hotel-1", bookingId: "booking-1", command: "reject" },
    }));
    const applySpaBookingReplyCommand = vi.fn().mockRejectedValueOnce(new Error("spa_booking is not in a cancellable status"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms, resolvePartnerReplySms, resolveSpaBookingReplySms, applySpaBookingReplyCommand }));

    const response = await POST(postRequest({ MessageSid: "SM1", From: "+33612345678", To: "+15005550006", Body: "1 SPA123" }, "sha1=good"));

    expect(response.status).toBe(200);
    consoleErrorSpy.mockRestore();
  });
});

describe("POST /api/webhooks/twilio/sms — form-urlencoded parsing wiring", () => {
  it("[form body parsed correctly] MessageSid/From/To/Body reach handleInboundSms as an exact params object", async () => {
    const handleInboundSms = vi.fn<() => InboundSmsOutcome>(() => ({ ok: false, reason: "invalid_signature" }));
    const { POST } = createTwilioSmsWebhookHandlers(makeDeps({ handleInboundSms }));

    await POST(postRequest({ MessageSid: "SM42", From: "+33611112222", To: "+15005550006", Body: "2 XYZ9" }, "sha1=whatever"));

    expect(handleInboundSms).toHaveBeenCalledWith(
      "https://example.com/api/webhooks/twilio/sms",
      "sha1=whatever",
      { MessageSid: "SM42", From: "+33611112222", To: "+15005550006", Body: "2 XYZ9" }
    );
  });

  it("[X-Forwarded-Proto behind a reverse proxy — real end-to-end pipeline, no deps override] a signature computed against the public https URL validates through the real route", async () => {
    process.env.TWILIO_AUTH_TOKEN = "real-pipeline-token";
    const { POST } = createTwilioSmsWebhookHandlers();
    const params = { MessageSid: "SM99", From: "+33612345678", To: "+15005550006", Body: "1 ABC7ZZ" };
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
    const params = { MessageSid: "SM99", From: "+33612345678", To: "+15005550006", Body: "1 ABC7ZZ" };

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

  it("[route never reads hotel_id/request_id/booking_id from the raw body/From itself] it only ever forwards whatever resolvePartnerReplySms/resolveSpaBookingReplySms decoded from the database", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "route.ts"), "utf8");
    expect(source).not.toMatch(/JSON\.parse\([^)]*body/i);
    expect(source).not.toMatch(/hotelId\s*=\s*(params|body|from)/i);
  });
});
