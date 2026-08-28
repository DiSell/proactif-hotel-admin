import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppProvider, WhatsAppSendResult, WhatsAppWebhookParseResult } from "./types";

const ORIGINAL_TEMPLATE = process.env.WHATSAPP_PARTNER_REQUEST_TEMPLATE;

afterEach(() => {
  if (ORIGINAL_TEMPLATE === undefined) delete process.env.WHATSAPP_PARTNER_REQUEST_TEMPLATE;
  else process.env.WHATSAPP_PARTNER_REQUEST_TEMPLATE = ORIGINAL_TEMPLATE;
  vi.restoreAllMocks();
});

interface FakeRow {
  partnerRequest?: Record<string, unknown> | null;
  partner?: Record<string, unknown> | null;
  hotel?: Record<string, unknown> | null;
}

function fakeSupabase({ partnerRequest = null, partner = null, hotel = null }: FakeRow) {
  const rows: Record<string, Record<string, unknown> | null> = {
    partner_requests: partnerRequest,
    hotel_partners: partner,
    hotels: hotel,
  };
  const from = vi.fn((table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: rows[table], error: null }) }),
        maybeSingle: async () => ({ data: rows[table], error: null }), // hotels lookup only has a single .eq()
      }),
    }),
  }));
  return { from };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    hotel_id: "hotel-1",
    partner_id: "partner-1",
    conversation_id: "conv-1",
    guest_name: "Marie Dupont",
    request_category: "restaurant",
    requested_date: "2026-09-01",
    requested_time: "20:00",
    party_size: 2,
    details: "Table près de la fenêtre",
    status: "pending_confirmation",
    partner_response: null,
    responded_at: null,
    guest_notification_status: "pending",
    guest_notified_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function eligiblePartner(overrides: Record<string, unknown> = {}) {
  return {
    id: "partner-1",
    hotel_id: "hotel-1",
    name: "Le Bistrot",
    category: "restaurant",
    is_active: true,
    consent_status: "accepted",
    whatsapp_consent_status: "accepted",
    request_phone_e164: "+33612345678",
    ...overrides,
  };
}

function configureEnv() {
  process.env.WHATSAPP_PARTNER_REQUEST_TEMPLATE = "partner_request_v1";
}

describe("prepareWhatsAppPartnerRequest — eligibility gates", () => {
  it("[request not found] -> request_not_found", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: null });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "request_not_found" });
  });

  it.each(["draft", "sent_to_partner", "accepted", "rejected", "cancelled"])("[request status %s not sendable] -> request_not_eligible", async (status) => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest({ status }), partner: eligiblePartner(), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "request_not_eligible" });
  });

  it("[partner inactive] -> partner_not_eligible", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest(), partner: eligiblePartner({ is_active: false }), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    expect(await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never })).toEqual({
      ok: false,
      error: "partner_not_eligible",
    });
  });

  it("[recommendation consent not accepted] -> partner_not_eligible", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest(), partner: eligiblePartner({ consent_status: "pending" }), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    expect(await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never })).toEqual({
      ok: false,
      error: "partner_not_eligible",
    });
  });

  it("[WhatsApp consent not accepted] -> partner_not_eligible", async () => {
    configureEnv();
    const supabase = fakeSupabase({
      partnerRequest: baseRequest(),
      partner: eligiblePartner({ whatsapp_consent_status: "not_requested" }),
      hotel: { name: "Hôtel Test" },
    });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    expect(await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never })).toEqual({
      ok: false,
      error: "partner_not_eligible",
    });
  });

  it("[request_phone_e164 absent] -> missing_phone", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest(), partner: eligiblePartner({ request_phone_e164: null }), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    expect(await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never })).toEqual({ ok: false, error: "missing_phone" });
  });

  it("[request_phone_e164 invalid] -> invalid_phone", async () => {
    configureEnv();
    const supabase = fakeSupabase({
      partnerRequest: baseRequest(),
      partner: eligiblePartner({ request_phone_e164: "0612345678" }),
      hotel: { name: "Hôtel Test" },
    });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    expect(await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never })).toEqual({ ok: false, error: "invalid_phone" });
  });

  it("[template not configured] -> template_not_configured", async () => {
    delete process.env.WHATSAPP_PARTNER_REQUEST_TEMPLATE;
    const supabase = fakeSupabase({ partnerRequest: baseRequest(), partner: eligiblePartner(), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    expect(await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never })).toEqual({
      ok: false,
      error: "template_not_configured",
    });
  });
});

describe("prepareWhatsAppPartnerRequest — purpose inference (never a caller-supplied value)", () => {
  it("[pending_confirmation] -> initial_request", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest({ status: "pending_confirmation" }), partner: eligiblePartner(), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result.ok && result.prepared.purpose).toBe("initial_request");
  });

  it("[alternative_proposed] -> alternative_acceptance", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest({ status: "alternative_proposed" }), partner: eligiblePartner(), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result.ok && result.prepared.purpose).toBe("alternative_acceptance");
  });
});

describe("prepareWhatsAppPartnerRequest — payload construction, no PII/internal ids", () => {
  it("[eligible] returns the phone, template, and business bodyParams — NEVER a network call, NEVER a reply token", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest(), partner: eligiblePartner(), hotel: { name: "Hôtel Magnifique" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.requestPhoneE164).toBe("+33612345678");
    expect(result.prepared.templateName).toBe("partner_request_v1");
    expect(result.prepared.bodyParams).toContain("Hôtel Magnifique");
    expect(result.prepared.bodyParams).toContain("restaurant");
    expect(result.prepared.bodyParams).toContain("2026-09-01");
    expect(result.prepared.bodyParams).toContain("20:00");
    expect(result.prepared.bodyParams).toContain("2");
    expect(result.prepared.bodyParams).toContain("Table près de la fenêtre");
  });

  it("[guest first name only, never the full name]", async () => {
    configureEnv();
    const supabase = fakeSupabase({ partnerRequest: baseRequest({ guest_name: "Marie Dupont" }), partner: eligiblePartner(), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result.ok && result.prepared.bodyParams).toContain("Marie");
    expect(JSON.stringify(result.ok && result.prepared.bodyParams)).not.toMatch(/Dupont/);
  });

  it("[short reference, never the full UUID]", async () => {
    configureEnv();
    const requestId = "abcdef12-3456-7890-abcd-ef1234567890";
    const supabase = fakeSupabase({ partnerRequest: baseRequest({ id: requestId }), partner: eligiblePartner(), hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest(requestId, "hotel-1", { supabase: supabase as never });

    const bodyParams = result.ok ? result.prepared.bodyParams : [];
    expect(bodyParams).not.toContain(requestId);
    expect(JSON.stringify(bodyParams)).not.toMatch(new RegExp(requestId));
    expect(bodyParams.some((p) => p.toUpperCase() === "ABCDEF12")).toBe(true);
  });

  it("[guest_phone_e164 never appears] even if present on the raw row (defense in depth)", async () => {
    configureEnv();
    const supabase = fakeSupabase({
      partnerRequest: baseRequest({ guest_phone_e164: "+33698765432" }),
      partner: eligiblePartner(),
      hotel: { name: "Hôtel Test" },
    });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(JSON.stringify(result)).not.toMatch(/33698765432/);
  });

  it("[no internal ids leak] hotel_id/conversation_id/partner_id never appear in bodyParams", async () => {
    configureEnv();
    const supabase = fakeSupabase({
      partnerRequest: baseRequest({ hotel_id: "hotel-uuid-1", conversation_id: "conv-uuid-1", partner_id: "partner-uuid-1" }),
      partner: eligiblePartner({ id: "partner-uuid-1", hotel_id: "hotel-uuid-1" }),
      hotel: { name: "Hôtel Test" },
    });
    const { prepareWhatsAppPartnerRequest } = await import("./sendPartnerRequest");

    const result = await prepareWhatsAppPartnerRequest("req-1", "hotel-uuid-1", { supabase: supabase as never });

    expect(JSON.stringify(result.ok && result.prepared.bodyParams)).not.toMatch(/hotel-uuid-1|conv-uuid-1|partner-uuid-1/);
  });
});

describe("sendPreparedPartnerRequestTemplate — the actual provider call", () => {
  function prepared(overrides: Record<string, unknown> = {}) {
    return {
      purpose: "initial_request" as const,
      requestPhoneE164: "+33612345678",
      templateName: "partner_request_v1",
      languageCode: "fr",
      bodyParams: ["Hôtel Test", "restaurant"],
      ...overrides,
    };
  }

  function fakeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
    return {
      sendTemplateMessage: vi.fn<() => Promise<WhatsAppSendResult>>(async () => ({ ok: true, providerMessageId: "wamid.test" })),
      verifyWebhookChallenge: vi.fn(() => null),
      parseWebhookPayload: vi.fn<() => WhatsAppWebhookParseResult>(() => ({ ok: false, error: "invalid_signature" })),
      ...overrides,
    };
  }

  it("[builds buttons from the GIVEN tokens, never generates its own]", async () => {
    const provider = fakeProvider();
    const { sendPreparedPartnerRequestTemplate } = await import("./sendPartnerRequest");

    await sendPreparedPartnerRequestTemplate(prepared(), { accept: "raw-accept", reject: "raw-reject", alternative: "raw-alt" }, { provider });

    expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(1);
    const message = (provider.sendTemplateMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(message.buttons).toEqual([
      { label: "Accepter", payload: "raw-accept" },
      { label: "Refuser", payload: "raw-reject" },
      { label: "Proposer une alternative", payload: "raw-alt" },
    ]);
    expect(message.toE164).toBe("+33612345678");
    expect(message.templateName).toBe("partner_request_v1");
    expect(message.bodyParams).toEqual(["Hôtel Test", "restaurant"]);
  });

  it("[provider success] returns providerMessageId unchanged", async () => {
    const provider = fakeProvider({ sendTemplateMessage: vi.fn<() => Promise<WhatsAppSendResult>>(async () => ({ ok: true, providerMessageId: "wamid.real" })) });
    const { sendPreparedPartnerRequestTemplate } = await import("./sendPartnerRequest");

    const result = await sendPreparedPartnerRequestTemplate(prepared(), { accept: "a", reject: "r", alternative: "alt" }, { provider });

    expect(result).toEqual({ ok: true, providerMessageId: "wamid.real" });
  });

  it("[provider certain failure] mapped straight through", async () => {
    const provider = fakeProvider({ sendTemplateMessage: vi.fn<() => Promise<WhatsAppSendResult>>(async () => ({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" })) });
    const { sendPreparedPartnerRequestTemplate } = await import("./sendPartnerRequest");

    const result = await sendPreparedPartnerRequestTemplate(prepared(), { accept: "a", reject: "r", alternative: "alt" }, { provider });

    expect(result).toEqual({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
  });

  it("[provider ambiguous outcome] mapped straight through, distinct from provider_error", async () => {
    const provider = fakeProvider({ sendTemplateMessage: vi.fn<() => Promise<WhatsAppSendResult>>(async () => ({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" })) });
    const { sendPreparedPartnerRequestTemplate } = await import("./sendPartnerRequest");

    const result = await sendPreparedPartnerRequestTemplate(prepared(), { accept: "a", reject: "r", alternative: "alt" }, { provider });

    expect(result).toEqual({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
  });
});
