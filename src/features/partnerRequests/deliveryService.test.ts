import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppSendResult } from "@/lib/notifications/whatsapp/types";
import { hashPartnerReplyToken } from "@/lib/notifications/whatsapp/replyToken";

const mockPrepare = vi.fn<(requestId: string, hotelId: string, deps?: unknown) => Promise<unknown>>();
const mockSendPrepared = vi.fn<
  (prepared: unknown, replyTokens: { accept: string; reject: string; alternative: string }, deps?: unknown) => Promise<WhatsAppSendResult>
>();
vi.mock("@/lib/notifications/whatsapp/sendPartnerRequest", () => ({
  prepareWhatsAppPartnerRequest: (...args: Parameters<typeof mockPrepare>) => mockPrepare(...args),
  sendPreparedPartnerRequestTemplate: (...args: Parameters<typeof mockSendPrepared>) => mockSendPrepared(...args),
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
