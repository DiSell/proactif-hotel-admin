import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppSendResult } from "@/lib/notifications/whatsapp/types";
import { hashPartnerReplyToken } from "@/lib/notifications/whatsapp/replyToken";
import type { SmsSendResult } from "@/lib/notifications/sms/types";
import { hashSmsReplyCode } from "@/lib/notifications/sms/smsReplyCode";

const mockPrepare = vi.fn<(requestId: string, hotelId: string, deps?: unknown) => Promise<unknown>>();
const mockSendPrepared = vi.fn<
  (prepared: unknown, replyTokens: { accept: string; reject: string; alternative: string }, deps?: unknown) => Promise<WhatsAppSendResult>
>();
vi.mock("@/lib/notifications/whatsapp/sendPartnerRequest", () => ({
  prepareWhatsAppPartnerRequest: (...args: Parameters<typeof mockPrepare>) => mockPrepare(...args),
  sendPreparedPartnerRequestTemplate: (...args: Parameters<typeof mockSendPrepared>) => mockSendPrepared(...args),
}));

const mockPrepareSms = vi.fn<(requestId: string, hotelId: string, deps?: unknown) => Promise<unknown>>();
const mockSendPreparedSms = vi.fn<(prepared: unknown, code: string, deps?: unknown) => Promise<SmsSendResult>>();
vi.mock("@/lib/notifications/sms/sendPartnerRequestSms", () => ({
  prepareSmsPartnerRequest: (...args: Parameters<typeof mockPrepareSms>) => mockPrepareSms(...args),
  sendPreparedPartnerRequestSms: (...args: Parameters<typeof mockSendPreparedSms>) => mockSendPreparedSms(...args),
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
  prepared: {
    purpose: "initial_request" as const,
    requestPhoneE164: "+33612345678",
    templateName: "partner_request_v1",
    languageCode: "fr",
    bodyParams: ["Hôtel Test"],
  },
};

/** Records every RPC call and lets each test script canned responses per-function-name, in call order. */
function fakeSupabaseRpc(responses: Record<string, { data?: unknown; error?: { code?: string; message: string } | null }[]>) {
  const callCounts: Record<string, number> = {};
  const rpc = vi.fn<(fn: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>>(
    async (fn) => {
      const queue = responses[fn] ?? [];
      const index = callCounts[fn] ?? 0;
      callCounts[fn] = index + 1;
      const response = queue[index] ?? { data: null, error: null };
      return { data: response.data ?? null, error: response.error ?? null };
    }
  );
  return { rpc };
}

describe("deliverPartnerRequest — full lifecycle (task section 11)", () => {
  it("[provider not configured] returns before creating or starting a delivery", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    delete process.env.WHATSAPP_PROVIDER;
    const supabase = fakeSupabaseRpc({});
    const { deliverPartnerRequest } = await import("./deliveryService");
    const result = await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });
    expect(result).toEqual({ ok: false, error: "provider_not_configured", attempted: false });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(mockSendPrepared).not.toHaveBeenCalled();
  });
  it("[not eligible] prepareWhatsAppPartnerRequest fails -> returns immediately, NO delivery row created, provider never called", async () => {
    mockPrepare.mockResolvedValueOnce({ ok: false, error: "missing_phone" });
    const supabase = fakeSupabaseRpc({});
    const { deliverPartnerRequest } = await import("./deliveryService");

    const result = await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "missing_phone" });
    expect(supabase.rpc).not.toHaveBeenCalledWith("create_partner_request_delivery", expect.anything());
    expect(mockSendPrepared).not.toHaveBeenCalled();
  });

  it("[concurrent delivery already in progress] create_partner_request_delivery 23505 -> delivery_already_in_progress, provider never called", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: null, error: { code: "23505", message: "duplicate" } }],
    });
    const { deliverPartnerRequest } = await import("./deliveryService");

    const result = await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "delivery_already_in_progress" });
    expect(mockSendPrepared).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalledWith("start_partner_request_delivery", expect.anything());
  });

  it("[success] create -> start (hashes persisted BEFORE the provider call) -> send -> complete('sent') -> partner_delivery_succeeded", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: true, providerMessageId: "wamid.real" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequest } = await import("./deliveryService");

    const result = await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: true, providerMessageId: "wamid.real" });

    const calls = supabase.rpc.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      "create_partner_request_delivery",
      "start_partner_request_delivery",
      "complete_partner_request_delivery",
      "apply_partner_request_command",
    ]);

    const startArgs = supabase.rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(startArgs.p_delivery_id).toBe("delivery-1");
    expect(typeof startArgs.p_accept_token_hash).toBe("string");
    expect(typeof startArgs.p_reject_token_hash).toBe("string");
    expect(typeof startArgs.p_propose_alternative_token_hash).toBe("string");

    const completeArgs = supabase.rpc.mock.calls[2][1] as Record<string, unknown>;
    expect(completeArgs).toMatchObject({ p_delivery_id: "delivery-1", p_outcome: "sent", p_provider_message_id: "wamid.real" });

    const commandArgs = supabase.rpc.mock.calls[3][1] as Record<string, unknown>;
    expect(commandArgs).toMatchObject({ p_partner_request_id: "req-1", p_hotel_id: "hotel-1", p_command: "partner_delivery_succeeded" });
  });

  it("[send() is called with the RAW tokens whose HASHES were just persisted]", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: true, providerMessageId: "wamid.real" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequest } = await import("./deliveryService");

    await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    const startArgs = supabase.rpc.mock.calls[1][1] as Record<string, string>;
    const sendCallArgs = mockSendPrepared.mock.calls[0][1] as { accept: string; reject: string; alternative: string };
    expect(hashPartnerReplyToken(sendCallArgs.accept)).toBe(startArgs.p_accept_token_hash);
    expect(hashPartnerReplyToken(sendCallArgs.reject)).toBe(startArgs.p_reject_token_hash);
    expect(hashPartnerReplyToken(sendCallArgs.alternative)).toBe(startArgs.p_propose_alternative_token_hash);
  });

  it("[certain failure] provider_error -> complete('failed') -> partner_delivery_failed, never sent_to_partner", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequest } = await import("./deliveryService");

    const result = await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    const completeArgs = supabase.rpc.mock.calls[2][1] as Record<string, unknown>;
    expect(completeArgs).toMatchObject({ p_outcome: "failed", p_provider_message_id: null });
    const commandArgs = supabase.rpc.mock.calls[3][1] as Record<string, unknown>;
    expect(commandArgs.p_command).toBe("partner_delivery_failed");
  });

  it("[ambiguous outcome] provider_unknown -> complete('unknown') -> partner_delivery_ambiguous, never sent_to_partner, never a certain failure", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequest } = await import("./deliveryService");

    const result = await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
    const completeArgs = supabase.rpc.mock.calls[2][1] as Record<string, unknown>;
    expect(completeArgs).toMatchObject({ p_outcome: "unknown", p_provider_message_id: null });
    const commandArgs = supabase.rpc.mock.calls[3][1] as Record<string, unknown>;
    expect(commandArgs.p_command).toBe("partner_delivery_ambiguous");
  });

  it("[ambiguous outcome] no automatic retry — deliverPartnerRequest itself never calls create/start/send a second time", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequest } = await import("./deliveryService");

    await deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never });

    expect(supabase.rpc.mock.calls.filter((c) => c[0] === "create_partner_request_delivery")).toHaveLength(1);
    expect(mockSendPrepared).toHaveBeenCalledTimes(1);
  });

  it("[concurrency, task section 12] two concurrent calls for the same request/purpose -> only ONE ever reaches the provider, the second sees delivery_already_in_progress", async () => {
    mockPrepare.mockResolvedValue(OK_PREPARED);
    mockSendPrepared.mockResolvedValue({ ok: true, providerMessageId: "wamid.real" });

    // Simulates the DB-level race: the SECOND create_partner_request_delivery
    // call (regardless of which application-level call issues it first)
    // hits the real partial unique index and gets 23505 — this is
    // DB-backed, not an in-memory mutex, so it holds even if two separate
    // Node processes raced each other.
    let createCallCount = 0;
    const rpc = vi.fn(async (fn: string) => {
      if (fn === "create_partner_request_delivery") {
        createCallCount += 1;
        if (createCallCount === 1) return { data: "delivery-1", error: null };
        return { data: null, error: { code: "23505", message: "duplicate" } };
      }
      return { data: null, error: null };
    });
    const supabase = { rpc };
    const { deliverPartnerRequest } = await import("./deliveryService");

    const [resultA, resultB] = await Promise.all([
      deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never }),
      deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never }),
    ]);

    const outcomes = [resultA, resultB];
    const inProgress = outcomes.filter((r) => !r.ok && r.error === "delivery_already_in_progress");
    const succeeded = outcomes.filter((r) => r.ok);
    expect(inProgress).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    expect(mockSendPrepared).toHaveBeenCalledTimes(1);
  });

  it("[RPC failure propagates] a failing apply_partner_request_command call throws, never silently swallowed", async () => {
    mockPrepare.mockResolvedValueOnce(OK_PREPARED);
    mockSendPrepared.mockResolvedValueOnce({ ok: true, providerMessageId: "wamid.x" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null, error: { message: "not allowed from status sent_to_partner" } }],
    });
    const { deliverPartnerRequest } = await import("./deliveryService");

    await expect(deliverPartnerRequest("req-1", "hotel-1", { supabase: supabase as never })).rejects.toThrow(/not allowed/);
  });
});

describe("reconcileStaleSendingDelivery", () => {
  const NOW = Date.parse("2026-08-29T12:00:00.000Z");

  function reconciliationSupabase(initialStatus: "sending" | "unknown" = "sending") {
    let status = initialStatus;
    let ambiguousEvents = 0;
    const rpc = vi.fn(async (fn: string) => {
      if (fn === "complete_partner_request_delivery") {
        if (status !== "sending") return { data: null, error: { message: `delivery not in sending status (found ${status})` } };
        status = "unknown";
        return { data: null, error: null };
      }
      if (fn === "apply_partner_request_command") {
        ambiguousEvents += 1;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    });
    const from = vi.fn(() => ({
      select: () => ({
        eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => ({
          maybeSingle: async () => ({ data: { id: "delivery-1", status, updated_at: "2026-08-29T11:50:00.000Z" }, error: null }),
        }) }) }) }) }),
      }),
    }));
    return { client: { rpc, from }, rpc, getStatus: () => status, getAmbiguousEvents: () => ambiguousEvents };
  }

  it("[fresh sending] remains sending and performs no DB transition or event", async () => {
    const db = reconciliationSupabase();
    const { reconcileStaleSendingDelivery, WHATSAPP_SENDING_STALE_AFTER_MS } = await import("./deliveryService");
    const result = await reconcileStaleSendingDelivery(
      { id: "delivery-1", status: "sending", updatedAt: new Date(NOW - WHATSAPP_SENDING_STALE_AFTER_MS + 1).toISOString() },
      "req-1", "hotel-1", { supabase: db.client as never, nowMs: NOW }
    );
    expect(result).toBe("sending");
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("[threshold exactly reached] persists unknown then emits exactly one ambiguous event", async () => {
    const db = reconciliationSupabase();
    const { reconcileStaleSendingDelivery, WHATSAPP_SENDING_STALE_AFTER_MS } = await import("./deliveryService");
    const result = await reconcileStaleSendingDelivery(
      { id: "delivery-1", status: "sending", updatedAt: new Date(NOW - WHATSAPP_SENDING_STALE_AFTER_MS).toISOString() },
      "req-1", "hotel-1", { supabase: db.client as never, nowMs: NOW }
    );
    expect(result).toBe("unknown");
    expect(db.getStatus()).toBe("unknown");
    expect(db.getAmbiguousEvents()).toBe(1);
    expect(db.rpc.mock.calls.map((call) => call[0])).toEqual(["complete_partner_request_delivery", "apply_partner_request_command"]);
  });

  it("[two stale observers] only the transition winner emits partner_delivery_ambiguous", async () => {
    const db = reconciliationSupabase();
    const { reconcileStaleSendingDelivery } = await import("./deliveryService");
    const stale = { id: "delivery-1", status: "sending" as const, updatedAt: "2026-08-29T11:50:00.000Z" };
    const [first, second] = await Promise.all([
      reconcileStaleSendingDelivery(stale, "req-1", "hotel-1", { supabase: db.client as never, nowMs: NOW }),
      reconcileStaleSendingDelivery(stale, "req-1", "hotel-1", { supabase: db.client as never, nowMs: NOW }),
    ]);
    expect([first, second]).toEqual(["unknown", "unknown"]);
    expect(db.getAmbiguousEvents()).toBe(1);
  });
});

describe("resolvePartnerReplyToken — hash lookup, never decoding", () => {
  function fakeSupabaseForLookup(rows: Record<string, { id: string; hotel_id: string; partner_request_id: string } | null>) {
    const from = vi.fn(() => ({
      select: () => ({
        eq: (column: string, value: string) => ({
          in: () => ({
            maybeSingle: async () => ({ data: rows[`${column}:${value}`] ?? null, error: null }),
          }),
        }),
      }),
    }));
    return { from };
  }

  it("[empty token] returns null without ever calling the database", async () => {
    const { resolvePartnerReplyToken } = await import("./deliveryService");
    const supabase = fakeSupabaseForLookup({});

    const result = await resolvePartnerReplyToken("", supabase as never);

    expect(result).toBeNull();
  });

  it("[accept token matches] resolves to partner_accept", async () => {
    const acceptHash = hashPartnerReplyToken("raw-accept-token");
    const supabase = fakeSupabaseForLookup({
      [`accept_reply_token_hash:${acceptHash}`]: { id: "delivery-1", hotel_id: "hotel-1", partner_request_id: "req-1" },
    });
    const { resolvePartnerReplyToken } = await import("./deliveryService");

    const result = await resolvePartnerReplyToken("raw-accept-token", supabase as never);

    expect(result).toEqual({ deliveryId: "delivery-1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_accept" });
  });

  it("[reject token matches] resolves to partner_reject", async () => {
    const rejectHash = hashPartnerReplyToken("raw-reject-token");
    const supabase = fakeSupabaseForLookup({
      [`reject_reply_token_hash:${rejectHash}`]: { id: "delivery-2", hotel_id: "hotel-1", partner_request_id: "req-2" },
    });
    const { resolvePartnerReplyToken } = await import("./deliveryService");

    const result = await resolvePartnerReplyToken("raw-reject-token", supabase as never);

    expect(result?.command).toBe("partner_reject");
  });

  it("[alternative token matches] resolves to partner_propose_alternative", async () => {
    const altHash = hashPartnerReplyToken("raw-alt-token");
    const supabase = fakeSupabaseForLookup({
      [`propose_alternative_token_hash:${altHash}`]: { id: "delivery-3", hotel_id: "hotel-1", partner_request_id: "req-3" },
    });
    const { resolvePartnerReplyToken } = await import("./deliveryService");

    const result = await resolvePartnerReplyToken("raw-alt-token", supabase as never);

    expect(result?.command).toBe("partner_propose_alternative");
  });

  it("[unknown/foreign token] resolves to null — no row matches any column", async () => {
    const supabase = fakeSupabaseForLookup({});
    const { resolvePartnerReplyToken } = await import("./deliveryService");

    const result = await resolvePartnerReplyToken("never-issued-token", supabase as never);

    expect(result).toBeNull();
  });

  it("[status filter applied] the query scopes to status IN (sent, unknown) — verified via the actual .in() call arguments", async () => {
    const inSpy = vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: null }) }));
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ in: inSpy }) }) }));
    const supabase = { from };
    const { resolvePartnerReplyToken } = await import("./deliveryService");

    await resolvePartnerReplyToken("some-token", supabase as never);

    expect(inSpy).toHaveBeenCalledWith("status", ["sent", "unknown"]);
  });

  it("[queries the correct table] partner_request_deliveries, never partner_requests directly", async () => {
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ in: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }));
    const supabase = { from };
    const { resolvePartnerReplyToken } = await import("./deliveryService");

    await resolvePartnerReplyToken("some-token", supabase as never);

    expect(from).toHaveBeenCalledWith("partner_request_deliveries");
  });
});

describe("applyPartnerReplyCommand", () => {
  it("[accept] calls the RPC with the exact command, no metadata, message passed through", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const supabase = { rpc };
    const { applyPartnerReplyCommand } = await import("./deliveryService");

    await applyPartnerReplyCommand("req-1", "hotel-1", "partner_accept", null, supabase as never);

    expect(rpc).toHaveBeenCalledWith("apply_partner_request_command", {
      p_partner_request_id: "req-1",
      p_hotel_id: "hotel-1",
      p_command: "partner_accept",
      p_message: null,
      p_metadata: null,
    });
  });

  it("[no verification performed here] this function trusts its args as-is — verification+correlation is resolvePartnerReplyToken's own job; final authorization is apply_partner_request_command()'s own status guard", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "deliveryService.ts"), "utf8");
    const fn = source.slice(source.indexOf("export async function applyPartnerReplyCommand"));
    expect(fn).not.toMatch(/hashPartnerReplyToken/);
  });

  it("[RPC error propagates]", async () => {
    const supabase = { rpc: vi.fn(async () => ({ data: null, error: { message: "boom" } })) };
    const { applyPartnerReplyCommand } = await import("./deliveryService");

    await expect(applyPartnerReplyCommand("req-1", "hotel-1", "partner_reject", null, supabase as never)).rejects.toThrow("boom");
  });
});

describe("deliverPartnerRequest — production wiring boundary", () => {
  it("[server flow only] partnerRequestFlow wires delivery, chatbotService still does not", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const chatbotServiceSource = readFileSync(join(here, "chatbotService.ts"), "utf8");
    const flowSource = readFileSync(join(here, "..", "rag", "partnerRequestFlow.ts"), "utf8");
    expect(chatbotServiceSource).not.toMatch(/deliveryService|sendPartnerRequest|deliverPartnerRequest/);
    expect(flowSource).toMatch(/deliveryService/);
    expect(flowSource).toMatch(/deliverPartnerRequest/);
  });

  it("[no Server Action calls it] no exported action in features/partnerRequests/actions.ts references deliverPartnerRequest", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const actionsSource = readFileSync(join(here, "actions.ts"), "utf8");
    expect(actionsSource).not.toMatch(/deliveryService|deliverPartnerRequest|sendPartnerRequest/);
  });
});

const OK_PREPARED_SMS = {
  ok: true as const,
  prepared: {
    purpose: "initial_request" as const,
    requestPhoneE164: "+33612345678",
    hotelName: "Le 1837",
    requestCategory: "Restaurant",
    requestedDate: null,
    requestedTime: "20h30",
    partySize: 4,
    guestFirstName: "Marie",
  },
};

describe("deliverPartnerRequestViaSms — PHASE 2, full lifecycle, NOT wired to any production trigger", () => {
  it("[provider not configured] returns before creating or starting a delivery", async () => {
    mockPrepareSms.mockResolvedValueOnce(OK_PREPARED_SMS);
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_SMS_FROM;
    const supabase = fakeSupabaseRpc({});
    const { deliverPartnerRequestViaSms } = await import("./deliveryService");

    const result = await deliverPartnerRequestViaSms("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_not_configured" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(mockSendPreparedSms).not.toHaveBeenCalled();
  });

  it("[not eligible] prepareSmsPartnerRequest fails -> returns immediately, no delivery row created", async () => {
    mockPrepareSms.mockResolvedValueOnce({ ok: false, error: "missing_phone" });
    const supabase = fakeSupabaseRpc({});
    const { deliverPartnerRequestViaSms } = await import("./deliveryService");

    const result = await deliverPartnerRequestViaSms("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "missing_phone" });
    expect(supabase.rpc).not.toHaveBeenCalledWith("create_partner_request_delivery", expect.anything());
  });

  it("[concurrent delivery already in progress] 23505 -> delivery_already_in_progress, provider never called", async () => {
    mockPrepareSms.mockResolvedValueOnce(OK_PREPARED_SMS);
    const supabase = fakeSupabaseRpc({ create_partner_request_delivery: [{ data: null, error: { code: "23505", message: "duplicate" } }] });
    const { deliverPartnerRequestViaSms } = await import("./deliveryService");

    const result = await deliverPartnerRequestViaSms("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "delivery_already_in_progress" });
    expect(mockSendPreparedSms).not.toHaveBeenCalled();
  });

  it("[success] create(provider=twilio_sms) -> start_partner_request_delivery_sms (ONE code hash, not three) -> send -> complete('sent') -> partner_delivery_succeeded", async () => {
    mockPrepareSms.mockResolvedValueOnce(OK_PREPARED_SMS);
    mockSendPreparedSms.mockResolvedValueOnce({ ok: true, providerMessageId: "SM_real" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery_sms: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequestViaSms } = await import("./deliveryService");

    const result = await deliverPartnerRequestViaSms("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: true, providerMessageId: "SM_real" });

    const createArgs = supabase.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(createArgs.p_provider).toBe("twilio_sms");

    const startArgs = supabase.rpc.mock.calls[1][1] as Record<string, unknown>;
    expect(startArgs.p_delivery_id).toBe("delivery-1");
    expect(typeof startArgs.p_sms_reply_code_hash).toBe("string");
    expect(startArgs).not.toHaveProperty("p_accept_token_hash");

    const sendCallArgs = mockSendPreparedSms.mock.calls[0] as [unknown, string];
    expect(hashSmsReplyCode(sendCallArgs[1])).toBe(startArgs.p_sms_reply_code_hash);

    const commandArgs = supabase.rpc.mock.calls[3][1] as Record<string, unknown>;
    expect(commandArgs).toMatchObject({ p_partner_request_id: "req-1", p_hotel_id: "hotel-1", p_command: "partner_delivery_succeeded" });
  });

  it("[certain failure] provider_error -> complete('failed') -> partner_delivery_failed", async () => {
    mockPrepareSms.mockResolvedValueOnce(OK_PREPARED_SMS);
    mockSendPreparedSms.mockResolvedValueOnce({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    const supabase = fakeSupabaseRpc({
      create_partner_request_delivery: [{ data: "delivery-1" }],
      start_partner_request_delivery_sms: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequestViaSms } = await import("./deliveryService");

    const result = await deliverPartnerRequestViaSms("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" });
    const commandArgs = supabase.rpc.mock.calls[3][1] as Record<string, unknown>;
    expect(commandArgs.p_command).toBe("partner_delivery_failed");
  });
});

describe("resolvePartnerReplySms — PHASE 2, parse -> hash -> lookup -> From-check, hotel_id NEVER from the SMS itself", () => {
  function fakeSupabaseForSmsResolve(config: {
    deliveryByHash?: Record<string, { id: string; hotel_id: string; partner_request_id: string }>;
    requestPartnerId?: Record<string, string>;
    partnerPhone?: Record<string, string | null>;
  }) {
    const from = vi.fn((table: string) => {
      if (table === "partner_request_deliveries") {
        return {
          select: () => ({
            eq: (_col1: string, hash: string) => ({
              eq: () => ({
                in: () => ({
                  maybeSingle: async () => ({ data: config.deliveryByHash?.[hash] ?? null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "partner_requests") {
        return {
          select: () => ({
            eq: (_col1: string, requestId: string) => ({
              eq: () => ({
                maybeSingle: async () => {
                  const partnerId = config.requestPartnerId?.[requestId];
                  return { data: partnerId ? { partner_id: partnerId } : null, error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "hotel_partners") {
        return {
          select: () => ({
            eq: (_col1: string, partnerId: string) => ({
              eq: () => ({
                maybeSingle: async () => {
                  const phone = config.partnerPhone?.[partnerId];
                  return { data: phone !== undefined ? { request_phone_e164: phone } : null, error: null };
                },
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
    return { from };
  }

  it("[unparseable body] returns unparseable WITHOUT any DB call", async () => {
    const from = vi.fn();
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("bonjour", "+33612345678", { from } as never);

    expect(result).toEqual({ ok: false, reason: "unparseable" });
    expect(from).not.toHaveBeenCalled();
  });

  it("[digit 3, no free text] returns missing_alternative_text WITHOUT any DB call — the request is never touched", async () => {
    const from = vi.fn();
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("3 K7M4PZ", "+33612345678", { from } as never);

    expect(result).toEqual({ ok: false, reason: "missing_alternative_text" });
    expect(from).not.toHaveBeenCalled();
  });

  it("[code unknown] returns code_not_found", async () => {
    const supabase = fakeSupabaseForSmsResolve({});
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("1 K7M4PZ", "+33612345678", supabase as never);

    expect(result).toEqual({ ok: false, reason: "code_not_found" });
  });

  it("[code found, wrong From] returns wrong_sender, no command derived", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33698765432" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("1 K7M4PZ", "+33600000000", supabase as never);

    expect(result).toEqual({ ok: false, reason: "wrong_sender" });
  });

  it("[digit 1, correct From] resolves partner_accept with the DB-derived ids, message null", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("1 K7M4PZ", "+33612345678", supabase as never);

    expect(result).toEqual({
      ok: true,
      resolved: { deliveryId: "d1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_accept", message: null },
    });
  });

  it("[digit 2] resolves partner_reject", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("2 K7M4PZ", "+33612345678", supabase as never);

    expect(result.ok && result.resolved.command).toBe("partner_reject");
  });

  it("[digit 3 with free text '21h00'] resolves partner_propose_alternative with the sanitized message", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("3 K7M4PZ 21h00", "+33612345678", supabase as never);

    expect(result).toEqual({
      ok: true,
      resolved: { deliveryId: "d1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_propose_alternative", message: "21h00" },
    });
  });

  it("[digit 3, free text containing a phone number] the message is sanitized via the SAME redactPhoneNumbers rule as partner_request_events.message, never the raw number", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("3 K7M4PZ Rappelez-moi au 06 12 34 56 78", "+33612345678", supabase as never);

    expect(result.ok).toBe(true);
    expect(result.ok && result.resolved.message).not.toContain("06 12 34 56 78");
  });

  it("[two simultaneous deliveries, different codes, same partner phone] each code resolves ONLY to its own delivery/request — no ambiguity", async () => {
    const hashA = hashSmsReplyCode("AAAAAA");
    const hashB = hashSmsReplyCode("BBBBBB");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: {
        [hashA]: { id: "d-a", hotel_id: "hotel-1", partner_request_id: "req-A" },
        [hashB]: { id: "d-b", hotel_id: "hotel-1", partner_request_id: "req-B" },
      },
      requestPartnerId: { "req-A": "partner-1", "req-B": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const resultA = await resolvePartnerReplySms("1 AAAAAA", "+33612345678", supabase as never);
    const resultB = await resolvePartnerReplySms("2 BBBBBB", "+33612345678", supabase as never);

    expect(resultA.ok && resultA.resolved.partnerRequestId).toBe("req-A");
    expect(resultB.ok && resultB.resolved.partnerRequestId).toBe("req-B");
  });

  it("[tenant isolation] a delivery's hotel_id is read exclusively from the resolved row, never supplied or guessable from the call", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-tenant-A", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("1 K7M4PZ", "+33612345678", supabase as never);

    expect(result.ok && result.resolved.hotelId).toBe("hotel-tenant-A");
  });

  it("[replay — code re-used after already resolved once] resolvePartnerReplySms itself has no memory; a second identical inbound reply resolves to the SAME delivery again — the RPC's own row lock + status guard is what actually blocks a real replay, unchanged by SMS", async () => {
    const hash = hashSmsReplyCode("K7M4PZ");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d1", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const first = await resolvePartnerReplySms("1 K7M4PZ", "+33612345678", supabase as never);
    const second = await resolvePartnerReplySms("1 K7M4PZ", "+33612345678", supabase as never);

    expect(first).toEqual(second);
  });

  it("[digit 1 on an alternative_acceptance delivery] resolves partner_accept — resolvePartnerReplySms is purpose-agnostic by construction (no .eq('purpose', ...) filter), same mechanism reused for the reconfirmation step", async () => {
    const hash = hashSmsReplyCode("ABC123");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d-reconfirm", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("1 ABC123", "+33612345678", supabase as never);

    expect(result).toEqual({
      ok: true,
      resolved: { deliveryId: "d-reconfirm", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_accept", message: null },
    });
  });

  it("[digit 2 on an alternative_acceptance delivery] resolves partner_reject", async () => {
    const hash = hashSmsReplyCode("ABC123");
    const supabase = fakeSupabaseForSmsResolve({
      deliveryByHash: { [hash]: { id: "d-reconfirm", hotel_id: "hotel-1", partner_request_id: "req-1" } },
      requestPartnerId: { "req-1": "partner-1" },
      partnerPhone: { "partner-1": "+33612345678" },
    });
    const { resolvePartnerReplySms } = await import("./deliveryService");

    const result = await resolvePartnerReplySms("2 ABC123", "+33612345678", supabase as never);

    expect(result.ok && result.resolved.command).toBe("partner_reject");
  });

  it("[queries the correct table for the code lookup] partner_request_deliveries, filtered by provider=twilio_sms", async () => {
    const eqSpy = vi.fn(() => ({ in: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }));
    const from = vi.fn((table: string) => {
      if (table === "partner_request_deliveries") return { select: () => ({ eq: () => ({ eq: eqSpy }) }) };
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
    });

    const { resolvePartnerReplySms } = await import("./deliveryService");
    await resolvePartnerReplySms("1 K7M4PZ", "+33612345678", { from } as never);

    expect(from).toHaveBeenCalledWith("partner_request_deliveries");
  });
});

describe("deliverPartnerRequestAlternativeAcceptance — PHASE 2, transport selected from the PERSISTED initial_request delivery, never from client input", () => {
  function fakeSupabaseWithTransport(provider: string | null, rpcResponses: Record<string, { data?: unknown; error?: { code?: string; message: string } | null }[]>) {
    const callCounts: Record<string, number> = {};
    const rpc = vi.fn(async (fn: string, params: Record<string, unknown>) => {
      void params; // kept in the signature only so .mock.calls[n][1] is typed and assertable by callers
      const queue = rpcResponses[fn] ?? [];
      const index = callCounts[fn] ?? 0;
      callCounts[fn] = index + 1;
      const response = queue[index] ?? { data: null, error: null };
      return { data: response.data ?? null, error: response.error ?? null };
    });
    const from = vi.fn((table: string) => {
      if (table !== "partner_request_deliveries") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => ({ maybeSingle: async () => ({ data: provider ? { provider } : null, error: null }) }),
                }),
              }),
            }),
          }),
        }),
      };
    });
    return { rpc, from };
  }

  it("[original transport was meta] reuses deliverPartnerRequest UNCHANGED — the WhatsApp template send path is invoked, never the SMS one", async () => {
    mockPrepare.mockResolvedValueOnce({
      ok: true,
      prepared: { purpose: "alternative_acceptance", requestPhoneE164: "+33612345678", templateName: "t", languageCode: "fr", bodyParams: [] },
    });
    mockSendPrepared.mockResolvedValueOnce({ ok: true, providerMessageId: "wamid.reconfirm" });
    const supabase = fakeSupabaseWithTransport("meta", {
      create_partner_request_delivery: [{ data: "delivery-2" }],
      start_partner_request_delivery: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequestAlternativeAcceptance } = await import("./deliveryService");

    const result = await deliverPartnerRequestAlternativeAcceptance("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: true, providerMessageId: "wamid.reconfirm" });
    expect(mockSendPrepared).toHaveBeenCalledTimes(1);
    expect(mockSendPreparedSms).not.toHaveBeenCalled();
  });

  it("[original transport was twilio_sms] uses deliverPartnerRequestViaSms — a NEW code is generated (never the previous delivery's code)", async () => {
    mockPrepareSms.mockResolvedValueOnce({
      ok: true,
      prepared: {
        purpose: "alternative_acceptance",
        requestPhoneE164: "+33612345678",
        hotelName: "Le 1837",
        requestCategory: "Restaurant",
        requestedDate: null,
        requestedTime: "20h30",
        partySize: 4,
        guestFirstName: "Marie",
        partnerResponse: "21h00",
      },
    });
    mockSendPreparedSms.mockResolvedValueOnce({ ok: true, providerMessageId: "SM_reconfirm" });
    const supabase = fakeSupabaseWithTransport("twilio_sms", {
      create_partner_request_delivery: [{ data: "delivery-2" }],
      start_partner_request_delivery_sms: [{ data: null }],
      complete_partner_request_delivery: [{ data: null }],
      apply_partner_request_command: [{ data: null }],
    });
    const { deliverPartnerRequestAlternativeAcceptance } = await import("./deliveryService");

    const result = await deliverPartnerRequestAlternativeAcceptance("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: true, providerMessageId: "SM_reconfirm" });
    expect(mockSendPreparedSms).toHaveBeenCalledTimes(1);
    expect(mockSendPrepared).not.toHaveBeenCalled();

    const startArgs = supabase.rpc.mock.calls.find((c) => c[0] === "start_partner_request_delivery_sms")?.[1] as Record<string, unknown>;
    const sentCode = (mockSendPreparedSms.mock.calls[0] as [unknown, string])[1];
    expect(hashSmsReplyCode(sentCode)).toBe(startArgs.p_sms_reply_code_hash);
    expect(sentCode).not.toBe("K7M4PZ"); // the original request's own code, never reused
  });

  it("[transport undetermined — no prior delivery found] returns a clean error, calls no RPC, never guesses a transport", async () => {
    const supabase = fakeSupabaseWithTransport(null, {});
    const { deliverPartnerRequestAlternativeAcceptance } = await import("./deliveryService");

    const result = await deliverPartnerRequestAlternativeAcceptance("req-1", "hotel-1", { supabase: supabase as never });

    expect(result).toEqual({ ok: false, error: "transport_undetermined" });
    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(mockSendPrepared).not.toHaveBeenCalled();
    expect(mockSendPreparedSms).not.toHaveBeenCalled();
  });
});

describe("reconcileStaleSendingDelivery — purpose parameter (PHASE 2)", () => {
  it("[purpose defaults to initial_request] existing WhatsApp call sites keep their exact prior behavior — re-reads the initial_request delivery, unchanged", async () => {
    const fromCalls: string[][] = [];
    const rpc = vi.fn(async (fn: string) => (fn === "complete_partner_request_delivery" ? { data: null, error: { message: "delivery not in sending status (found unknown)" } } : { data: null, error: null }));
    const from = vi.fn(() => ({
      select: () => ({
        eq: (col: string, val: string) => {
          fromCalls.push([col, val]);
          return {
            eq: () => ({ eq: (c2: string, v2: string) => { fromCalls.push([c2, v2]); return { order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: "delivery-1", status: "unknown", updated_at: "2026-08-29T11:50:00.000Z" }, error: null }) }) }) }; } }),
          };
        },
      }),
    }));
    const { reconcileStaleSendingDelivery } = await import("./deliveryService");

    await reconcileStaleSendingDelivery(
      { id: "delivery-1", status: "sending", updatedAt: "2026-08-29T11:50:00.000Z" },
      "req-1",
      "hotel-1",
      { supabase: { rpc, from } as never, nowMs: Date.parse("2026-08-29T12:00:00.000Z") }
    );

    expect(fromCalls.some(([col, val]) => col === "purpose" && val === "initial_request")).toBe(true);
  });

  it("[purpose='alternative_acceptance' explicitly passed] re-reads the CORRECT (alternative_acceptance) delivery, not initial_request — the bug this session's own audit caught before it could ship", async () => {
    const fromCalls: string[][] = [];
    const rpc = vi.fn(async (fn: string) => (fn === "complete_partner_request_delivery" ? { data: null, error: { message: "delivery not in sending status" } } : { data: null, error: null }));
    const from = vi.fn(() => ({
      select: () => ({
        eq: (col: string, val: string) => {
          fromCalls.push([col, val]);
          return {
            eq: () => ({ eq: (c2: string, v2: string) => { fromCalls.push([c2, v2]); return { order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: { id: "delivery-2", status: "unknown", updated_at: "2026-08-29T11:50:00.000Z" }, error: null }) }) }) }; } }),
          };
        },
      }),
    }));
    const { reconcileStaleSendingDelivery } = await import("./deliveryService");

    await reconcileStaleSendingDelivery(
      { id: "delivery-2", status: "sending", updatedAt: "2026-08-29T11:50:00.000Z" },
      "req-1",
      "hotel-1",
      { supabase: { rpc, from } as never, nowMs: Date.parse("2026-08-29T12:00:00.000Z"), purpose: "alternative_acceptance" }
    );

    expect(fromCalls.some(([col, val]) => col === "purpose" && val === "alternative_acceptance")).toBe(true);
    expect(fromCalls.some(([col, val]) => col === "purpose" && val === "initial_request")).toBe(false);
  });
});
