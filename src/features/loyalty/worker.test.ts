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
    for (const method of ["select", "eq", "lte", "gte", "is", "order", "limit", "in", "update", "insert", "delete"]) {
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

  const baseSettings = {
    hotel_id: "hotel-1",
    enabled: true,
    subject: "s",
    content: "c",
    thank_you_enabled: true,
    review_enabled: false,
    review_content: "Votre avis nous serait précieux.",
    review_url: null as string | null,
    review_button_label: "Laisser un avis",
  };

  it("[post_stay] never requires or includes an unsubscribe link, even without the secret configured", async () => {
    delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [{ data: baseSettings }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(result).toEqual({ status: "sent" });
    const sendArgs = mockSendEmail.mock.calls[0][0] as { text: string; html: string };
    expect(sendArgs.text).not.toMatch(/desinscription/);
    expect(sendArgs.html).not.toMatch(/desinscription/);
  });

  it("[post_stay composition] thank-you only — no review block in the email", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [{ data: { ...baseSettings, thank_you_enabled: true, review_enabled: false } }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(result).toEqual({ status: "sent" });
    const sendArgs = mockSendEmail.mock.calls[0][0] as { subject: string; text: string; html: string };
    expect(sendArgs.subject).toBe("s");
    expect(sendArgs.text).toContain("c");
    expect(sendArgs.html).not.toContain("Laisser un avis");
    expect(sendArgs.text).not.toContain("Votre avis nous serait précieux.");
  });

  it("[post_stay composition] review only (thank_you disabled) — the button/link is present, thank-you content is not", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [
        {
          data: {
            ...baseSettings,
            content: "THANK_YOU_MARKER",
            thank_you_enabled: false,
            review_enabled: true,
            review_url: "https://example.com/review",
            review_button_label: "Donner mon avis",
          },
        },
      ],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(result).toEqual({ status: "sent" });
    const sendArgs = mockSendEmail.mock.calls[0][0] as { text: string; html: string };
    expect(sendArgs.html).toContain('href="https://example.com/review"');
    expect(sendArgs.html).toContain("Donner mon avis");
    expect(sendArgs.text).not.toContain("THANK_YOU_MARKER");
  });

  it("[post_stay composition] both blocks active — both appear in the same single email", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [{ data: { ...baseSettings, thank_you_enabled: true, review_enabled: true, review_url: "https://example.com/review" } }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(result).toEqual({ status: "sent" });
    expect(mockSendEmail).toHaveBeenCalledTimes(1); // one combined email, not two
    const sendArgs = mockSendEmail.mock.calls[0][0] as { text: string; html: string };
    expect(sendArgs.text).toContain("c");
    expect(sendArgs.html).toContain('href="https://example.com/review"');
  });

  it("[revalidation / CAS 4] stay no longer 'completed' at transport time — skipped, no email sent, reservation undone (not a terminal skip)", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "cancelled" } }],
      loyalty_settings: [{ data: baseSettings }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(result).toEqual({ status: "skipped" });
    expect(mockSendEmail).not.toHaveBeenCalled();
    // The reservation is UNDONE, not finalized: the delivery row is
    // deleted (freeing the idempotency key) and loyalty_delivery_queued_at
    // is cleared back to null (freeing the due-stays query's filter) — see
    // worker.ts's own comment on this branch. No "no_longer_due" row is
    // left behind; that would have permanently condemned the stay exactly
    // like the pre-fix behavior this test used to assert.
    const deleteCall = supabase.calls.find((c) => c.table === "loyalty_deliveries" && c.method === "delete");
    expect(deleteCall).toBeTruthy();
    const clearQueuedAt = supabase.calls.find((c) => c.table === "customer_stays" && c.method === "update" && (c.args[0] as Record<string, unknown>).loyalty_delivery_queued_at === null);
    expect(clearQueuedAt).toBeTruthy();
    expect(supabase.calls.some((c) => c.table === "loyalty_deliveries" && c.method === "update" && (c.args[0] as Record<string, unknown>).safe_error === "no_longer_due")).toBe(false);
  });

  it("[CAS 4, continued] the same stay can be genuinely retried by a later cron run once it's completed again — not treated as a duplicate", async () => {
    // First run ("not due"): insert(1) + queued-at mark(1) + hotel_customers
    // read(1) + [status read + settings read](1 each) + [delete(1) +
    // clear-queued-at(1)] cleanup. Second run ("due, sent"): insert(1) +
    // queued-at mark(1) + hotel_customers read(1) + [status read + settings
    // read](1 each) + "sending" update(1) + "sent" update(1). Every queue
    // below is sized to exactly that real sequence, not a coincidental
    // fallback — see the earlier fix to the plain idempotency test above.
    const supabase = fakeSupabase({
      loyalty_deliveries: [
        { data: { id: "delivery-1" } }, // 1st run: insert succeeds
        { data: null, error: null }, // 1st run: delete (cleanup, ack irrelevant)
        { data: { id: "delivery-2" } }, // 2nd run: insert succeeds — key was freed
        { data: null, error: null }, // 2nd run: "sending" update
        { data: null, error: null }, // 2nd run: "sent" update
      ],
      customer_stays: [
        { data: null }, // 1st run: queued_at mark ack
        { data: { status: "cancelled" } }, // 1st run: fresh status read — not due
        { data: null }, // 1st run: clear-queued_at ack (cleanup)
        { data: null }, // 2nd run: queued_at mark ack
        { data: { status: "completed" } }, // 2nd run: fresh status read — now due
      ],
      loyalty_settings: [{ data: baseSettings }, { data: baseSettings }],
      hotel_customers: [
        { data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } },
        { data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } },
      ],
    });
    const { reserveAndSend } = await import("./worker");

    const first = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });
    const second = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(first).toEqual({ status: "skipped" });
    expect(second).toEqual({ status: "sent" }); // not "duplicate" — the retry genuinely goes through
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });

  it("[CAS 5] settings.enabled temporarily false at transport time — skipped, reservation undone, retriable after re-enabling", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [{ data: { ...baseSettings, enabled: false } }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(result).toEqual({ status: "skipped" });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(supabase.calls.some((c) => c.table === "loyalty_deliveries" && c.method === "delete")).toBe(true);
    expect(supabase.calls.some((c) => c.table === "customer_stays" && c.method === "update" && (c.args[0] as Record<string, unknown>).loyalty_delivery_queued_at === null)).toBe(true);
  });

  it("[CAS 6] both blocks disabled defensively at transport time — skipped, reservation undone, retriable once a block is reactivated", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [{ data: { ...baseSettings, thank_you_enabled: false, review_enabled: false } }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const result = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(result).toEqual({ status: "skipped" });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(supabase.calls.some((c) => c.table === "loyalty_deliveries" && c.method === "delete")).toBe(true);
    expect(supabase.calls.some((c) => c.table === "customer_stays" && c.method === "update" && (c.args[0] as Record<string, unknown>).loyalty_delivery_queued_at === null)).toBe(true);
  });

  it("[CAS 2] customer_unsubscribed — skipped DEFINITIVELY: the reservation is kept (never deleted), so a later cron never retries it", async () => {
    // First call: insert(1) + queued-at mark(1) + hotel_customers read(1) +
    // eligibility fails -> "skipped" update(1). Second call's insert then
    // hits the real unique-constraint error — 3 loyalty_deliveries entries,
    // not 2, or the second insert would consume the "skipped" update's slot
    // instead and pass for the wrong reason.
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }, { data: null, error: null }, { data: null, error: { code: "23505" } }],
      customer_stays: [{ data: null }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: true } }],
    });
    const { reserveAndSend } = await import("./worker");

    const first = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });
    const second = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(first).toEqual({ status: "skipped" });
    expect(second).toEqual({ status: "duplicate" }); // no retry, no starvation risk: permanently excluded
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(supabase.calls.some((c) => c.table === "loyalty_deliveries" && c.method === "delete")).toBe(false);
  });

  it("[CAS 3] hotel_excluded — skipped DEFINITIVELY, same as customer_unsubscribed", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }, { data: null, error: null }, { data: null, error: { code: "23505" } }],
      customer_stays: [{ data: null }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: true, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    const first = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });
    const second = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(first).toEqual({ status: "skipped" });
    expect(second).toEqual({ status: "duplicate" });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(supabase.calls.some((c) => c.table === "loyalty_deliveries" && c.method === "delete")).toBe(false);
  });

  it("[security] hotelier-controlled content containing <script> is HTML-escaped, never rendered as active markup", async () => {
    const supabase = fakeSupabase({
      loyalty_deliveries: [{ data: { id: "delivery-1" } }],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [
        {
          data: {
            ...baseSettings,
            content: '<script>alert("xss")</script>',
            review_enabled: true,
            review_url: "https://example.com/review",
            review_button_label: '"><img src=x onerror=alert(1)>',
          },
        },
      ],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    });
    const { reserveAndSend } = await import("./worker");

    await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    const sendArgs = mockSendEmail.mock.calls[0][0] as { html: string };
    expect(sendArgs.html).not.toContain("<script>");
    expect(sendArgs.html).toContain("&lt;script&gt;");
    expect(sendArgs.html).not.toMatch(/<img src=x onerror=/);
    expect(sendArgs.html).toContain("&quot;&gt;&lt;img");
  });

  it("[idempotency] the same stay processed twice (cron replayed) sends only one email", async () => {
    // One full successful reserveAndSend consumes 3 loyalty_deliveries
    // responses in order (insert, "sending" update, "sent" update) before
    // the second call's insert hits the real unique-constraint error — this
    // mirrors an actual Postgres replay, not a coincidental empty fallback.
    const responses = {
      loyalty_deliveries: [
        { data: { id: "delivery-1" } },
        { data: null, error: null },
        { data: null, error: null },
        { data: null, error: { code: "23505" } },
      ],
      customer_stays: [{ data: null }, { data: { status: "completed" } }],
      loyalty_settings: [{ data: baseSettings }],
      hotel_customers: [{ data: { id: "customer-1", hotel_id: "hotel-1", email: "a@b.fr", marketing_allowed: false, hotel_excluded: false, customer_unsubscribed: false } }],
    };
    const supabase = fakeSupabase(responses);
    const { reserveAndSend } = await import("./worker");

    const first = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });
    const second = await reserveAndSend({ supabase: supabase as never, hotelId: "hotel-1", customerId: "customer-1", stayId: "stay-1", type: "post_stay" });

    expect(first).toEqual({ status: "sent" });
    expect(second).toEqual({ status: "duplicate" });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
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
