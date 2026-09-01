import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppSendResult } from "@/lib/notifications/whatsapp/types";
import { hashSpaBookingReplyToken } from "@/lib/notifications/whatsapp/spaBookingReplyToken";

const mockPrepare = vi.fn<(bookingId: string, hotelId: string, deps?: unknown) => Promise<unknown>>();
const mockSendPrepared = vi.fn<(prepared: unknown, replyTokens: { accept: string; reject: string }, deps?: unknown) => Promise<WhatsAppSendResult>>();
vi.mock("@/lib/notifications/whatsapp/sendSpaBookingApproval", () => ({
  prepareWhatsAppSpaBookingApproval: (...args: Parameters<typeof mockPrepare>) => mockPrepare(...args),
  sendPreparedSpaBookingApprovalTemplate: (...args: Parameters<typeof mockSendPrepared>) => mockSendPrepared(...args),
}));

beforeEach(() => {
  process.env.WHATSAPP_PROVIDER = "meta";
  process.env.WHATSAPP_META_ACCESS_TOKEN = "test-token";
  process.env.WHATSAPP_META_PHONE_NUMBER_ID = "123";
  process.env.WHATSAPP_META_VERIFY_TOKEN = "verify";
  process.env.WHATSAPP_META_APP_SECRET = "secret";
  process.env.WHATSAPP_META_API_VERSION = "v21.0";
});

afterEach(() => {
  vi.restoreAllMocks();
  mockPrepare.mockReset();
  mockSendPrepared.mockReset();
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
