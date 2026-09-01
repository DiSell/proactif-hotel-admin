import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppProvider, WhatsAppSendResult, WhatsAppWebhookParseResult } from "./types";

const ORIGINAL_TEMPLATE = process.env.WHATSAPP_SPA_BOOKING_APPROVAL_TEMPLATE;

afterEach(() => {
  if (ORIGINAL_TEMPLATE === undefined) delete process.env.WHATSAPP_SPA_BOOKING_APPROVAL_TEMPLATE;
  else process.env.WHATSAPP_SPA_BOOKING_APPROVAL_TEMPLATE = ORIGINAL_TEMPLATE;
  vi.restoreAllMocks();
});

interface FakeRow {
  booking?: Record<string, unknown> | null;
  settings?: Record<string, unknown> | null;
  hotel?: Record<string, unknown> | null;
}

function fakeSupabase({ booking = null, settings = null, hotel = null }: FakeRow) {
  const rows: Record<string, Record<string, unknown> | null> = {
    spa_bookings: booking,
    hotel_spa_settings: settings,
    hotels: hotel,
  };
  const from = vi.fn((table: string) => ({
    select: () => ({
      eq: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: rows[table], error: null }) }),
        maybeSingle: async () => ({ data: rows[table], error: null }),
      }),
    }),
  }));
  return { from };
}

function baseBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    hotel_id: "hotel-1",
    status: "pending_approval",
    guest_name: "Marie Dupont",
    guest_phone_e164: "+33698765432",
    party_size: 2,
    booking_date: "2026-09-15",
    slot_start: "10:00:00",
    slot_end: "12:00:00",
    ...overrides,
  };
}

function configureEnv() {
  process.env.WHATSAPP_SPA_BOOKING_APPROVAL_TEMPLATE = "spa_booking_approval_v1";
}

describe("prepareWhatsAppSpaBookingApproval — eligibility gates", () => {
  it("[booking not found] -> booking_not_eligible", async () => {
    configureEnv();
    const supabase = fakeSupabase({ booking: null });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    const result = await prepareWhatsAppSpaBookingApproval("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "booking_not_eligible" });
  });

  it.each(["confirmed", "cancelled"])("[booking status %s not sendable] -> booking_not_eligible", async (status) => {
    configureEnv();
    const supabase = fakeSupabase({ booking: baseBooking({ status }), settings: { whatsapp_admin_phone_e164: "+33612345678" }, hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    const result = await prepareWhatsAppSpaBookingApproval("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "booking_not_eligible" });
  });

  it("[no admin phone configured] -> missing_phone", async () => {
    configureEnv();
    const supabase = fakeSupabase({ booking: baseBooking(), settings: { whatsapp_admin_phone_e164: null }, hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    expect(await prepareWhatsAppSpaBookingApproval("booking-1", "hotel-1", { supabase: supabase as never })).toEqual({ ok: false, error: "missing_phone" });
  });

  it("[admin phone invalid] -> invalid_phone", async () => {
    configureEnv();
    const supabase = fakeSupabase({ booking: baseBooking(), settings: { whatsapp_admin_phone_e164: "0612345678" }, hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    expect(await prepareWhatsAppSpaBookingApproval("booking-1", "hotel-1", { supabase: supabase as never })).toEqual({ ok: false, error: "invalid_phone" });
  });

  it("[template not configured] -> template_not_configured", async () => {
    delete process.env.WHATSAPP_SPA_BOOKING_APPROVAL_TEMPLATE;
    const supabase = fakeSupabase({ booking: baseBooking(), settings: { whatsapp_admin_phone_e164: "+33612345678" }, hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    expect(await prepareWhatsAppSpaBookingApproval("booking-1", "hotel-1", { supabase: supabase as never })).toEqual({ ok: false, error: "template_not_configured" });
  });
});

describe("prepareWhatsAppSpaBookingApproval — payload construction, no internal ids", () => {
  it("[eligible] returns the admin phone, template, and business bodyParams", async () => {
    configureEnv();
    const supabase = fakeSupabase({ booking: baseBooking(), settings: { whatsapp_admin_phone_e164: "+33612345678" }, hotel: { name: "Hôtel Magnifique" } });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    const result = await prepareWhatsAppSpaBookingApproval("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.requestPhoneE164).toBe("+33612345678");
    expect(result.prepared.templateName).toBe("spa_booking_approval_v1");
    expect(result.prepared.bodyParams).toContain("Hôtel Magnifique");
    expect(result.prepared.bodyParams).toContain("2026-09-15");
    expect(result.prepared.bodyParams).toContain("10:00 - 12:00");
    expect(result.prepared.bodyParams).toContain("2");
    expect(result.prepared.bodyParams).toContain("Marie");
    expect(result.prepared.bodyParams).toContain("+33698765432");
  });

  it("[guest first name only, never the full name]", async () => {
    configureEnv();
    const supabase = fakeSupabase({ booking: baseBooking({ guest_name: "Marie Dupont" }), settings: { whatsapp_admin_phone_e164: "+33612345678" }, hotel: { name: "Hôtel Test" } });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    const result = await prepareWhatsAppSpaBookingApproval("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result.ok && result.prepared.bodyParams).toContain("Marie");
    expect(JSON.stringify(result.ok && result.prepared.bodyParams)).not.toMatch(/Dupont/);
  });

  it("[no internal ids leak] hotel_id/booking_id never appear in bodyParams", async () => {
    configureEnv();
    const supabase = fakeSupabase({
      booking: baseBooking({ id: "booking-uuid-1", hotel_id: "hotel-uuid-1" }),
      settings: { whatsapp_admin_phone_e164: "+33612345678" },
      hotel: { name: "Hôtel Test" },
    });
    const { prepareWhatsAppSpaBookingApproval } = await import("./sendSpaBookingApproval");

    const result = await prepareWhatsAppSpaBookingApproval("booking-uuid-1", "hotel-uuid-1", { supabase: supabase as never });

    expect(JSON.stringify(result.ok && result.prepared.bodyParams)).not.toMatch(/hotel-uuid-1|booking-uuid-1/);
  });
});

describe("sendPreparedSpaBookingApprovalTemplate — the actual provider call", () => {
  function prepared(overrides: Record<string, unknown> = {}) {
    return {
      requestPhoneE164: "+33612345678",
      templateName: "spa_booking_approval_v1",
      languageCode: "fr",
      bodyParams: ["Hôtel Test", "2026-09-15"],
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

  it("[builds exactly 2 buttons — Confirmer/Refuser, never a third 'alternative' option]", async () => {
    const provider = fakeProvider();
    const { sendPreparedSpaBookingApprovalTemplate } = await import("./sendSpaBookingApproval");

    await sendPreparedSpaBookingApprovalTemplate(prepared(), { accept: "raw-accept", reject: "raw-reject" }, { provider });

    expect(provider.sendTemplateMessage).toHaveBeenCalledTimes(1);
    const message = (provider.sendTemplateMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(message.buttons).toEqual([
      { label: "Confirmer", payload: "raw-accept" },
      { label: "Refuser", payload: "raw-reject" },
    ]);
    expect(message.toE164).toBe("+33612345678");
  });

  it("[provider success] returns providerMessageId unchanged", async () => {
    const provider = fakeProvider({ sendTemplateMessage: vi.fn<() => Promise<WhatsAppSendResult>>(async () => ({ ok: true, providerMessageId: "wamid.real" })) });
    const { sendPreparedSpaBookingApprovalTemplate } = await import("./sendSpaBookingApproval");

    const result = await sendPreparedSpaBookingApprovalTemplate(prepared(), { accept: "a", reject: "r" }, { provider });

    expect(result).toEqual({ ok: true, providerMessageId: "wamid.real" });
  });

  it("[provider certain failure] mapped straight through", async () => {
    const provider = fakeProvider({ sendTemplateMessage: vi.fn<() => Promise<WhatsAppSendResult>>(async () => ({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" })) });
    const { sendPreparedSpaBookingApprovalTemplate } = await import("./sendSpaBookingApproval");

    const result = await sendPreparedSpaBookingApprovalTemplate(prepared(), { accept: "a", reject: "r" }, { provider });

    expect(result).toEqual({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
  });
});
