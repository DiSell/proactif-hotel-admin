import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppSendResult } from "@/lib/notifications/whatsapp/types";
import { hashSpaBookingReplyToken } from "@/lib/notifications/whatsapp/spaBookingReplyToken";
import type { SmsSendResult } from "@/lib/notifications/sms/types";
import { hashSmsReplyCode } from "@/lib/notifications/sms/smsReplyCode";

const mockPrepare = vi.fn<(bookingId: string, hotelId: string, deps?: unknown) => Promise<unknown>>();
const mockSendPrepared = vi.fn<(prepared: unknown, replyTokens: { accept: string; reject: string }, deps?: unknown) => Promise<WhatsAppSendResult>>();
vi.mock("@/lib/notifications/whatsapp/sendSpaBookingApproval", () => ({
  prepareWhatsAppSpaBookingApproval: (...args: Parameters<typeof mockPrepare>) => mockPrepare(...args),
  sendPreparedSpaBookingApprovalTemplate: (...args: Parameters<typeof mockSendPrepared>) => mockSendPrepared(...args),
}));

const mockPrepareSms = vi.fn<(bookingId: string, hotelId: string, deps?: unknown) => Promise<unknown>>();
const mockSendPreparedSms = vi.fn<(prepared: unknown, code: string, deps?: unknown) => Promise<SmsSendResult>>();
vi.mock("@/lib/notifications/sms/sendSpaBookingApprovalSms", () => ({
  prepareSmsSpaBookingApproval: (...args: Parameters<typeof mockPrepareSms>) => mockPrepareSms(...args),
  sendPreparedSpaBookingApprovalSms: (...args: Parameters<typeof mockSendPreparedSms>) => mockSendPreparedSms(...args),
}));

beforeEach(() => {
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.WHATSAPP_META_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_META_PHONE_NUMBER_ID = "123";
  process.env.WHATSAPP_META_VERIFY_TOKEN = "verify";
  process.env.WHATSAPP_META_APP_SECRET = "secret";
  process.env.WHATSAPP_META_API_VERSION = "v21.0";
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_SMS_FROM = "+15005550006";
});

afterEach(() => {
  vi.restoreAllMocks();
  mockPrepare.mockReset();
  mockSendPrepared.mockReset();
  mockPrepareSms.mockReset();
  mockSendPreparedSms.mockReset();
});

const OK_PREPARED = {
  ok: true as const,
  prepared: { requestPhoneE164: "+33612345678", templateName: "spa_booking_approval_v1", languageCode: "fr", bodyParams: ["Hôtel Test"] },
};

function fakeSupabaseRpc(responses: Record<string, { data?: unknown; error?: { code?: string; message: string } | null }[]>) {
  const callCounts: Record<string, number> = {};
  const rpc = vi.fn<(fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>>(async (fn) => {
    const queue = responses[fn] ?? [];
    const index = callCounts[fn] ?? 0;
    callCounts[fn] = index + 1;
    const response = queue[index] ?? { data: null, error: null };
    return { data: response.data ?? null, error: response.error ?? null };
  });
  return { rpc };
}

describe("deliverSpaBookingApprovalRequest — full lifecycle", () => {
  it("[provider not configured] returns before creating or starting a delivery", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    delete process.env.WHATSAPP_PROVIDER;
    const supabase = fakeSupabaseRpc({});
    const { deliverSpaBookingApprovalRequest } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequest("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_not_configured" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(mockSendPrepared).not.toHaveBeenCalled();
  });

  it("[not eligible] prepareWhatsAppSpaBookingApproval fails -> returns immediately, no delivery row created", async () => {
    mockPrepare.mockResolvedValueOnce({ ok: false, error: "missing_phone" });
    const supabase = fakeSupabaseRpc({});
    const { deliverSpaBookingApprovalRequest } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequest("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "missing_phone" });
    expect(supabase.rpc).not.toHaveBeenCalledWith("create_spa_booking_delivery", expect.anything());
    expect(mockSendPrepared).not.toHaveBeenCalled();
  });

  it("[concurrent delivery already in progress] create_spa_booking_delivery 23505 -> delivery_already_in_progress", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    const supabase = fakeSupabaseRpc({ create_spa_booking_delivery: [{ data: null, error: { code: "23505", message: "duplicate" } }] });
    const { deliverSpaBookingApprovalRequest } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequest("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "delivery_already_in_progress" });
    expect(mockSendPrepared).not.toHaveBeenCalled();
  });

  it("[success] create -> start (hashes persisted BEFORE the provider call) -> send -> complete('sent')", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: true, providerMessageId: "wamid.real" });
    const supabase = fakeSupabaseRpc({
      create_spa_booking_delivery: [{ data: "delivery-1" }],
      start_spa_booking_delivery: [{ data: null }],
      complete_spa_booking_delivery: [{ data: null }],
    });
    const { deliverSpaBookingApprovalRequest } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequest("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: true, providerMessageId: "wamid.real" });
    const calls = supabase.rpc.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["create_spa_booking_delivery", "start_spa_booking_delivery", "complete_spa_booking_delivery"]);

    const startArgs = supabase.rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(startArgs.p_delivery_id).toBe("delivery-1");
    expect(typeof startArgs.p_accept_token_hash).toBe("string");
    expect(typeof startArgs.p_reject_token_hash).toBe("string");
    expect(startArgs).not.toHaveProperty("p_propose_alternative_token_hash");

    const completeArgs = supabase.rpc.mock.calls[2][1] as Record<string, unknown>;
    expect(completeArgs).toMatchObject({ p_delivery_id: "delivery-1", p_outcome: "sent", p_provider_message_id: "wamid.real" });
  });

  it("[send() is called with the RAW tokens whose HASHES were just persisted]", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: true, providerMessageId: "wamid.real" });
    const supabase = fakeSupabaseRpc({
      create_spa_booking_delivery: [{ data: "delivery-1" }],
      start_spa_booking_delivery: [{ data: null }],
      complete_spa_booking_delivery: [{ data: null }],
    });
    const { deliverSpaBookingApprovalRequest } = await import("./deliveryService");

    await deliverSpaBookingApprovalRequest("booking-1", "hotel-1", { supabase: supabase as never });

    const startArgs = supabase.rpc.mock.calls[1][1] as Record<string, string>;
    const sendCallArgs = mockSendPrepared.mock.calls[0][1] as { accept: string; reject: string };
    expect(hashSpaBookingReplyToken(sendCallArgs.accept)).toBe(startArgs.p_accept_token_hash);
    expect(hashSpaBookingReplyToken(sendCallArgs.reject)).toBe(startArgs.p_reject_token_hash);
  });

  it("[certain failure] provider_error -> complete('failed'), no command applied (approve/reject stays the admin's own act)", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    const supabase = fakeSupabaseRpc({
      create_spa_booking_delivery: [{ data: "delivery-1" }],
      start_spa_booking_delivery: [{ data: null }],
      complete_spa_booking_delivery: [{ data: null }],
    });
    const { deliverSpaBookingApprovalRequest } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequest("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    const completeArgs = supabase.rpc.mock.calls[2][1] as Record<string, unknown>;
    expect(completeArgs).toMatchObject({ p_outcome: "failed", p_provider_message_id: null });
  });

  it("[ambiguous outcome] provider_unknown -> complete('unknown')", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
    const supabase = fakeSupabaseRpc({
      create_spa_booking_delivery: [{ data: "delivery-1" }],
      start_spa_booking_delivery: [{ data: null }],
      complete_spa_booking_delivery: [{ data: null }],
    });
    const { deliverSpaBookingApprovalRequest } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequest("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
    const completeArgs = supabase.rpc.mock.calls[2][1] as Record<string, unknown>;
    expect(completeArgs).toMatchObject({ p_outcome: "unknown" });
  });
});

describe("resolveSpaBookingReplyToken — hash lookup, never decoding", () => {
  function fakeSupabaseForLookup(rows: Record<string, { id: string; hotel_id: string; booking_id: string } | null>) {
    const from = vi.fn(() => ({
      select: () => ({
        eq: (column: string, value: string) => ({
          in: () => ({ maybeSingle: async () => ({ data: rows[`${column}:${value}`] ?? null, error: null }) }),
        }),
      }),
    }));
    return { from };
  }

  it("[empty token] returns null without ever calling the database", async () => {
    const { resolveSpaBookingReplyToken } = await import("./deliveryService");
    const supabase = fakeSupabaseForLookup({});

    expect(await resolveSpaBookingReplyToken("", supabase as never)).toBeNull();
  });

  it("[accept token matches] resolves to approve", async () => {
    const acceptHash = hashSpaBookingReplyToken("raw-accept-token");
    const supabase = fakeSupabaseForLookup({
      [`accept_reply_token_hash:${acceptHash}`]: { id: "delivery-1", hotel_id: "hotel-1", booking_id: "booking-1" },
    });
    const { resolveSpaBookingReplyToken } = await import("./deliveryService");

    const result = await resolveSpaBookingReplyToken("raw-accept-token", supabase as never);

    expect(result).toEqual({ deliveryId: "delivery-1", hotelId: "hotel-1", bookingId: "booking-1", command: "approve" });
  });

  it("[reject token matches] resolves to reject", async () => {
    const rejectHash = hashSpaBookingReplyToken("raw-reject-token");
    const supabase = fakeSupabaseForLookup({
      [`reject_reply_token_hash:${rejectHash}`]: { id: "delivery-2", hotel_id: "hotel-1", booking_id: "booking-2" },
    });
    const { resolveSpaBookingReplyToken } = await import("./deliveryService");

    const result = await resolveSpaBookingReplyToken("raw-reject-token", supabase as never);

    expect(result?.command).toBe("reject");
  });

  it("[unknown/foreign token] resolves to null", async () => {
    const supabase = fakeSupabaseForLookup({});
    const { resolveSpaBookingReplyToken } = await import("./deliveryService");

    expect(await resolveSpaBookingReplyToken("never-issued-token", supabase as never)).toBeNull();
  });

  it("[status filter applied] scopes to status IN (sent, unknown)", async () => {
    const inSpy = vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) }));
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ in: inSpy }) }) }));
    const supabase = { from };
    const { resolveSpaBookingReplyToken } = await import("./deliveryService");

    await resolveSpaBookingReplyToken("some-token", supabase as never);

    expect(inSpy).toHaveBeenCalledWith("status", ["sent", "unknown"]);
  });

  it("[queries the correct table] spa_booking_deliveries, never spa_bookings directly", async () => {
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ in: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }));
    const supabase = { from };
    const { resolveSpaBookingReplyToken } = await import("./deliveryService");

    await resolveSpaBookingReplyToken("some-token", supabase as never);

    expect(from).toHaveBeenCalledWith("spa_booking_deliveries");
  });
});

describe("applySpaBookingReplyCommand", () => {
  it("[approve] calls approve_spa_booking", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const supabase = { rpc };
    const { applySpaBookingReplyCommand } = await import("./deliveryService");

    await applySpaBookingReplyCommand("booking-1", "hotel-1", "approve", supabase as never);

    expect(rpc).toHaveBeenCalledWith("approve_spa_booking", { p_hotel_id: "hotel-1", p_booking_id: "booking-1" });
  });

  it("[reject] calls cancel_spa_booking with cancelled_by = 'hotel'", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const supabase = { rpc };
    const { applySpaBookingReplyCommand } = await import("./deliveryService");

    await applySpaBookingReplyCommand("booking-1", "hotel-1", "reject", supabase as never);

    expect(rpc).toHaveBeenCalledWith("cancel_spa_booking", { p_hotel_id: "hotel-1", p_booking_id: "booking-1", p_cancelled_by: "hotel" });
  });

  it("[RPC error propagates]", async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })) };
    const { applySpaBookingReplyCommand } = await import("./deliveryService");

    await expect(applySpaBookingReplyCommand("booking-1", "hotel-1", "approve", supabase as never)).rejects.toThrow("boom");
  });
});

const OK_PREPARED_SMS = {
  ok: true as const,
  prepared: { requestPhoneE164: "+33612345678", hotelName: "Le 1837", bookingDate: "2026-10-01", slotStart: "14:00", slotEnd: "15:00", partySize: 2, guestFirstName: "Marie" },
};

describe("deliverSpaBookingApprovalRequestViaSms — PHASE 2, NOT wired to any production trigger", () => {
  it("[provider not configured] returns before creating or starting a delivery", async () => {
    mockPrepareSms.mockResolvedValueOnce(OK_PREPARED_SMS);
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_SMS_FROM;
    const supabase = fakeSupabaseRpc({});
    const { deliverSpaBookingApprovalRequestViaSms } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequestViaSms("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_not_configured" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("[not eligible] returns immediately, no delivery created", async () => {
    mockPrepareSms.mockResolvedValueOnce({ ok: false, error: "missing_phone" });
    const supabase = fakeSupabaseRpc({});
    const { deliverSpaBookingApprovalRequestViaSms } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequestViaSms("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "missing_phone" });
  });

  it("[success] create(provider=twilio_sms) -> start_spa_booking_delivery_sms (ONE code hash) -> send -> complete('sent')", async () => {
    mockPrepareSms.mockResolvedValueOnce(OK_PREPARED_SMS);
    mockSendPreparedSms.mockResolvedValueOnce({ ok: true, providerMessageId: "SM_real" });
    const supabase = fakeSupabaseRpc({
      create_spa_booking_delivery: [{ data: "delivery-1" }],
      start_spa_booking_delivery_sms: [{ data: null }],
      complete_spa_booking_delivery: [{ data: null }],
    });
    const { deliverSpaBookingApprovalRequestViaSms } = await import("./deliveryService");

    const result = await deliverSpaBookingApprovalRequestViaSms("booking-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: true, providerMessageId: "SM_real" });
    const createArgs = supabase.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(createArgs.p_provider).toBe("twilio_sms");
    const startArgs = supabase.rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(typeof startArgs.p_sms_reply_code_hash).toBe("string");
    expect(startArgs).not.toHaveProperty("p_accept_token_hash");
  });
});

describe("resolveSpaBookingReplySms — PHASE 2, strictly digit 1/2, no alternative", () => {
  function fakeSupabaseForSmsResolve(config: {
    deliveryByHash?: Record<string, { id: string; hotel_id: string; booking_id: string }>;
    adminPhone?: Record<string, string | null>;
  }) {
    const from = vi.fn((table: string) => {
      if (table === "spa_booking_deliveries") {
        return { select: () => ({ eq: (_c: string, hash: string) => ({ eq: () => ({ in: () => ({ maybeSingle: async () => ({ data: config.deliveryByHash?.[hash] ?? null, error: null }) }) }) }) }) };
      }
      if (table === "hotel_spa_settings") {
        return {
          select: () => ({
            eq: (_c: string, hotelId: string) => ({
              maybeSingle: async () => {
                const phone = config.adminPhone?.[hotelId];
                return { data: phone !== undefined ? { whatsapp_admin_phone_e164: phone } : null, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    return { from };
  }

  it("[unparseable body] returns unparseable without any DB call", async () => {
    const from = vi.fn();
    const { resolveSpaBookingReplySms } = await import("./deliveryService");

    const result = await resolveSpaBookingReplySms("hello", "+33612345678", { from } as never);

    expect(result).toEqual({ ok: false, reason: "unparseable" });
    expect(from).not.toHaveBeenCalled();
  });

  it("[digit 3] rejected as invalid_digit — spa has no alternative, without ever looking up a code", async () => {
    const from = vi.fn();
    const { resolveSpaBookingReplySms } = await import("./deliveryService");

    const result = await resolveSpaBookingReplySms("3 K7M4PZ 21h00", "+33612345678", { from } as never);

    expect(result).toEqual({ ok: false, reason: "invalid_digit" });
    expect(from).not.toHaveBeenCalled();
  });

  it("[code unknown] returns code_not_found", async () => {
    const supabase = fakeSupabaseForSmsResolve({});
    const { resolveSpaBookingReplySms } = await import("./deliveryService");

    expect(await resolveSpaBookingReplySms("1 K7M4PZ", "+33612345678", supabase as never)).toEqual({ ok: false, reason: "code_not_found" });
  });

  it("[wrong From] returns wrong_sender", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", booking_id: "booking-1" } },
      adminPhone: { "hotel-1": "+33698765432" },
    });
    const { resolveSpaBookingReplySms } = await import("./deliveryService");

    expect(await resolveSpaBookingReplySms("1 K7M4PZ", "+33600000000", supabase as never)).toEqual({ ok: false, reason: "wrong_sender" });
  });

  it("[digit 1, correct From] resolves approve", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", booking_id: "booking-1" } },
      adminPhone: { "hotel-1": "+33612345678" },
    });
    const { resolveSpaBookingReplySms } = await import("./deliveryService");

    const result = await resolveSpaBookingReplySms("1 K7M4PZ", "+33612345678", supabase as never);

    expect(result).toEqual({ ok: true, resolved: { deliveryId: "d1", hotelId: "hotel-1", bookingId: "booking-1", command: "approve" } });
  });

  it("[digit 2] resolves reject", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", booking_id: "booking-1" } },
      adminPhone: { "hotel-1": "+33612345678" },
    });
    const { resolveSpaBookingReplySms } = await import("./deliveryService");

    const result = await resolveSpaBookingReplySms("2 K7M4PZ", "+33612345678", supabase as never);

    expect(result.ok && result.resolved.command).toBe("reject");
  });

  it("[tenant isolation] hotel_id comes exclusively from the resolved delivery row", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-tenant-B", booking_id: "booking-1" } },
      adminPhone: { "hotel-tenant-B": "+33612345678" },
    });
    const { resolveSpaBookingReplySms } = await import("./deliveryService");

    const result = await resolveSpaBookingReplySms("1 K7M4PZ", "+33612345678", supabase as never);

    expect(result.ok && result.resolved.hotelId).toBe("hotel-tenant-B");
  });
});
