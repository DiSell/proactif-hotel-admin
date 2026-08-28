import { describe, expect, it, vi } from "vitest";

function fakeSupabase(rows: unknown[] | null, singleRow: unknown = null) {
  const eqSecond = vi.fn(() => ({
    order: () => ({ returns: async () => ({ data: rows, error: null }) }),
    maybeSingle: async () => ({ data: singleRow, error: null }),
  }));
  const eqFirst = vi.fn(() => ({ eq: eqSecond, order: () => ({ returns: async () => ({ data: rows, error: null }) }) }));
  const select = vi.fn((columns: string) => ({ eq: eqFirst, columns }));
  const from = vi.fn(() => ({ select }));
  return { from, select, eqFirst, eqSecond };
}

/** Dedicated chain for getActivePartnerRequestForConversation's longer .eq().eq().in().order().limit().maybeSingle() shape. */
function fakeSupabaseForActiveRequest(row: unknown) {
  const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  const limit = vi.fn<(count: number) => { maybeSingle: typeof maybeSingle }>(() => ({ maybeSingle }));
  const order = vi.fn<(column: string, opts: { ascending: boolean }) => { limit: typeof limit }>(() => ({ limit }));
  const inFn = vi.fn<(column: string, values: string[]) => { order: typeof order }>(() => ({ order }));
  const eqSecond = vi.fn<(column: string, value: string) => { in: typeof inFn }>(() => ({ in: inFn }));
  const eqFirst = vi.fn<(column: string, value: string) => { eq: typeof eqSecond }>(() => ({ eq: eqSecond }));
  const select = vi.fn<(columns: string) => { eq: typeof eqFirst }>(() => ({ eq: eqFirst }));
  const from = vi.fn<(table: string) => { select: typeof select }>(() => ({ select }));
  return { from, select, eqFirst, eqSecond, in: inFn, order, limit, maybeSingle };
}

describe("partnerRequests/queries — required supabase client, no default", () => {
  it("[getPartnerRequestById] scopes by both id and hotel_id, uses partner_requests table", async () => {
    const { getPartnerRequestById } = await import("./queries");
    const supabase = fakeSupabase(null, { id: "req-1", hotel_id: "hotel-a" });

    await getPartnerRequestById("hotel-a", "req-1", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("partner_requests");
    expect(supabase.eqFirst).toHaveBeenCalledWith("id", "req-1");
    expect(supabase.eqSecond).toHaveBeenCalledWith("hotel_id", "hotel-a");
  });

  it("[getPartnerRequestById] never selects guest_phone_e164", async () => {
    const { getPartnerRequestById } = await import("./queries");
    const supabase = fakeSupabase(null, null);

    await getPartnerRequestById("hotel-a", "req-1", supabase as never);

    const [columns] = supabase.select.mock.calls[0];
    expect(columns).not.toMatch(/guest_phone_e164/);
    expect(columns).not.toBe("*");
  });

  it("[listPartnerRequestsForHotel] scopes by hotel_id, never selects guest_phone_e164", async () => {
    const { listPartnerRequestsForHotel } = await import("./queries");
    const supabase = fakeSupabase([]);

    await listPartnerRequestsForHotel("hotel-a", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("partner_requests");
    expect(supabase.eqFirst).toHaveBeenCalledWith("hotel_id", "hotel-a");
    const [columns] = supabase.select.mock.calls[0];
    expect(columns).not.toMatch(/guest_phone_e164/);
  });

  it("[listPartnerRequestEvents] scopes by both hotel_id and partner_request_id, uses partner_request_events table", async () => {
    const { listPartnerRequestEvents } = await import("./queries");
    const supabase = fakeSupabase([]);

    await listPartnerRequestEvents("hotel-a", "req-1", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("partner_request_events");
    expect(supabase.eqFirst).toHaveBeenCalledWith("hotel_id", "hotel-a");
    expect(supabase.eqSecond).toHaveBeenCalledWith("partner_request_id", "req-1");
  });

  it("[no results] listPartnerRequestsForHotel/listPartnerRequestEvents return [] rather than null", async () => {
    const { listPartnerRequestsForHotel, listPartnerRequestEvents } = await import("./queries");
    const supabaseNullRows = fakeSupabase(null);

    expect(await listPartnerRequestsForHotel("hotel-a", supabaseNullRows as never)).toEqual([]);
    expect(await listPartnerRequestEvents("hotel-a", "req-1", supabaseNullRows as never)).toEqual([]);
  });
});

describe("getActivePartnerRequestForConversation", () => {
  it("[scoped by hotel_id and conversation_id] uses partner_requests table", async () => {
    const { getActivePartnerRequestForConversation } = await import("./queries");
    const supabase = fakeSupabaseForActiveRequest(null);

    await getActivePartnerRequestForConversation("hotel-a", "conv-1", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("partner_requests");
    expect(supabase.eqFirst).toHaveBeenCalledWith("hotel_id", "hotel-a");
    expect(supabase.eqSecond).toHaveBeenCalledWith("conversation_id", "conv-1");
  });

  it("[active statuses only] filters to draft/pending_confirmation/sent_to_partner/alternative_proposed — never a resolved/cancelled request", async () => {
    const { getActivePartnerRequestForConversation } = await import("./queries");
    const supabase = fakeSupabaseForActiveRequest(null);

    await getActivePartnerRequestForConversation("hotel-a", "conv-1", supabase as never);

    expect(supabase.in).toHaveBeenCalledWith("status", ["draft", "pending_confirmation", "sent_to_partner", "alternative_proposed"]);
    expect(supabase.in.mock.calls[0][1]).not.toContain("accepted");
    expect(supabase.in.mock.calls[0][1]).not.toContain("rejected");
    expect(supabase.in.mock.calls[0][1]).not.toContain("cancelled");
  });

  it("[most recent only] orders by created_at desc and limits to 1", async () => {
    const { getActivePartnerRequestForConversation } = await import("./queries");
    const supabase = fakeSupabaseForActiveRequest(null);

    await getActivePartnerRequestForConversation("hotel-a", "conv-1", supabase as never);

    expect(supabase.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(supabase.limit).toHaveBeenCalledWith(1);
  });

  it("[never selects guest_phone_e164]", async () => {
    const { getActivePartnerRequestForConversation } = await import("./queries");
    const supabase = fakeSupabaseForActiveRequest(null);

    await getActivePartnerRequestForConversation("hotel-a", "conv-1", supabase as never);

    const [columns] = supabase.select.mock.calls[0];
    expect(columns).not.toMatch(/guest_phone_e164/);
  });

  it("[no active request] returns null", async () => {
    const { getActivePartnerRequestForConversation } = await import("./queries");
    const supabase = fakeSupabaseForActiveRequest(null);

    expect(await getActivePartnerRequestForConversation("hotel-a", "conv-1", supabase as never)).toBeNull();
  });

  it("[active request found] returns the row", async () => {
    const { getActivePartnerRequestForConversation } = await import("./queries");
    const row = { id: "req-1", hotel_id: "hotel-a", status: "pending_confirmation" };
    const supabase = fakeSupabaseForActiveRequest(row);

    expect(await getActivePartnerRequestForConversation("hotel-a", "conv-1", supabase as never)).toEqual(row);
  });
});

describe("getGuestPhoneForPartnerRequest — narrow, justified PII read", () => {
  it("[scoped by id and hotel_id] uses partner_requests table, selects only guest_phone_e164", async () => {
    const { getGuestPhoneForPartnerRequest } = await import("./queries");
    const supabase = fakeSupabase(null, { guest_phone_e164: "+33612345678" });

    await getGuestPhoneForPartnerRequest("hotel-a", "req-1", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("partner_requests");
    expect(supabase.eqFirst).toHaveBeenCalledWith("id", "req-1");
    expect(supabase.eqSecond).toHaveBeenCalledWith("hotel_id", "hotel-a");
    const [columns] = supabase.select.mock.calls[0];
    expect(columns).toBe("guest_phone_e164");
  });

  it("[value found] returns it", async () => {
    const { getGuestPhoneForPartnerRequest } = await import("./queries");
    const supabase = fakeSupabase(null, { guest_phone_e164: "+33612345678" });

    expect(await getGuestPhoneForPartnerRequest("hotel-a", "req-1", supabase as never)).toBe("+33612345678");
  });

  it("[no row / null value] returns null, never throws", async () => {
    const { getGuestPhoneForPartnerRequest } = await import("./queries");
    const supabase = fakeSupabase(null, null);

    expect(await getGuestPhoneForPartnerRequest("hotel-a", "req-1", supabase as never)).toBeNull();
  });
});
