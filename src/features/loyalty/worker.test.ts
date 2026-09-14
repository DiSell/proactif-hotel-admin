import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSendEmail = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; error?: string }>>(async () => ({ ok: true }));
vi.mock("@/lib/email/sendEmail", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

vi.mock("@/lib/http/currentOrigin", () => ({
  currentOrigin: async () => "https://app.example.com",
}));

beforeEach(() => {
  mockSendEmail.mockClear();
});

afterEach(() => {
  delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
  vi.restoreAllMocks();
});

/**
 * Hand-built recording fake — same convention as
 * lib/notifications/whatsapp/sendPartnerRequest.test.ts's fakeSupabaseRpc,
 * adapted for .from() chains: each table gets its own response queue,
 * consumed in call order, and every intermediate method (.select/.eq/.is/
 * .order/.limit/.update/.insert) just records itself and returns the same
 * chain — the chain is also awaitable directly (.then), matching how
 * worker.ts sometimes awaits the builder without a terminal .single()/
 * .maybeSingle() call.
 */
function fakeSupabase(responses: Record<string, { data?: unknown; error?: unknown }[]>) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const callIndex: Record<string, number> = {};

  function nextResponse(table: string) {
    const index = callIndex[table] ?? 0;
    callIndex[table] = index + 1;
    return (responses[table] ?? [])[index] ?? { data: null, error: null };
  }

  function makeChain(table: string) {
    const chain: Record<string, unknown> = {};
    const passthrough = (method: string) => (...args: unknown[]) => {
      calls.push({ table, method, args });
      return chain;
    };
    for (const method of ["select", "eq", "lte", "gte", "is", "order", "limit", "in", "update", "insert"]) {
      chain[method] = passthrough(method);
    }
    chain.single = async () => nextResponse(table);
    chain.maybeSingle = async () => nextResponse(table);
    chain.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(nextResponse(table)).then(onFulfilled, onRejected);
    return chain;
  }

  const from = vi.fn((table: string) => makeChain(table));
  return { from, calls };
}

describe("reserveAndSend — marketing emails must always carry a working unsubscribe link", () => {
  it("[secret not configured] fails closed: no email sent, delivery marked failed", async () => {
    delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: true, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", campaignId: "campaign-1", type: "marketing", subject: "s", content: "c" });

    expect(result).toEqual({ status: "failed" });
    expect(mockSendEmail).not.toHaveBeenCalled();
    const failUpdate = supabase.calls.find((c) => c.table === "loyalty_deliveries" && c.method === "update" && (c.args[0] as Record<string, unknown>).safe_error === "unsubscribe_link_unavailable");
    expect(failUpdate).toBeTruthy();
  });

  it("[secret configured] the link appears in both the text and html bodies actually sent", async () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "test-secret";
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: true, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", campaignId: "campaign-1", type: "marketing", subject: "s", content: "c" });

    expect(result).toEqual({ status: "sent" });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const sendArgs = mockSendEmail.mock.calls[0][0] as { text: string; html: string };
    expect(sendArgs.text).toContain("https://app.example.com/desinscription?token=");
    expect(sendArgs.html).toContain("https://app.example.com/desinscription?token=");
  });

  it("[post_stay] never requires or includes an unsubscribe link, even without the secret configured", async () => {
    delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay", subject: "s", content: "c" });

    expect(result).toEqual({ status: "sent" });
    const sendArgs = mockSendEmail.mock.calls[0][0] as { text: string; html: string };
    expect(sendArgs.text).not.toMatch(/desinscription/);
    expect(sendArgs.html).not.toMatch(/desinscription/);
  });

  it("[post_stay] marks the stay as attempted (loyalty_delivery_queued_at) right after reserving, before the send even happens", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay", subject: "s", content: "c" });

    const queuedUpdate = supabase.calls.find((c) => c.table === "customer_stays" && c.method === "update");
    expect(queuedUpdate).toBeTruthy();
    expect(queuedUpdate!.args[0]).toHaveProperty("loyalty_delivery_queued_at");
  });

  it("[duplicate reservation] a unique-constraint failure on insert returns 'duplicate' and never touches hotel_customers", async () => {
    const supabase = fakeSupabase({ loyalty_deliveries: [{ data: null, error: { code: "23505" } }] });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", campaignId: "campaign-1", type: "marketing", subject: "s", content: "c" });

    expect(result).toEqual({ status: "duplicate" });
    expect(supabase.calls.some((c) => c.table === "hotel_customers")).toBe(false);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("[ineligible at send time] skipped, never sent, even if it was eligible when scheduled", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", campaignId: "campaign-1", type: "marketing", subject: "s", content: "c" });

    expect(result).toEqual({ status: "skipped" });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe("runLoyaltyJobs — post-stay due query (0038_customer_loyalty_stay_tracking.sql)", () => {
  it("[starvation fix] excludes already-attempted stays and orders oldest-due-first", async () => {
    const supabase = fakeSupabase({
      loyalty_campaigns: [{ data: [] }],
      loyalty_settings: [{ data: [{ hotel_id: "hotel-1", delay_days: 3, subject: "s", content: "c" }] }],
      customer_stays: [{ data: [] }],
    });
    const { runLoyaltyJobs } = await import("./worker");

    await runLoyaltyJobs(supabase as never, new Date("2026-01-10T00:00:00Z"));

    const staysCall = supabase.calls.filter((c) => c.table === "customer_stays");
    expect(staysCall.some((c) => c.method === "is" && c.args[0] === "loyalty_delivery_queued_at" && c.args[1] === null)).toBe(true);
    expect(staysCall.some((c) => c.method === "order" && c.args[0] === "check_out" && (c.args[1] as { ascending: boolean }).ascending === true)).toBe(true);
  });
});
