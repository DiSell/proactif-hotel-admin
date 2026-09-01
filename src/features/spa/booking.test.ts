import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email/sendEmail", () => ({
  sendEmail: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/email/templates/spaBookingNotification", () => ({
  spaBookingNotificationTemplate: vi.fn(() => ({ subject: "s", html: "h", text: "t" })),
}));

const mockDeliverSpaBookingApprovalRequest = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; providerMessageId?: string }>>(async () => ({ ok: true, providerMessageId: "wamid.test" }));
vi.mock("./deliveryService", () => ({
  deliverSpaBookingApprovalRequest: (...args: unknown[]) => mockDeliverSpaBookingApprovalRequest(...args),
}));

interface FakeRow {
  [key: string]: unknown;
}

function makeQueryBuilder(rows: FakeRow[]) {
  const predicates: ((row: FakeRow) => boolean)[] = [];
  const builder = {
    eq(col: string, val: unknown) {
      predicates.push((row) => row[col] === val);
      return builder;
    },
    in(col: string, values: unknown[]) {
      predicates.push((row) => values.includes(row[col]));
      return builder;
    },
    async maybeSingle() {
      const match = rows.find((r) => predicates.every((p) => p(r)));
      return { data: match ?? null, error: null };
    },
    returns() {
      const filtered = rows.filter((r) => predicates.every((p) => p(r)));
      return Promise.resolve({ data: filtered, error: null });
    },
  };
  return builder;
}

function makeFakeSupabase(
  tables: Record<string, FakeRow[]>,
  rpcImpl: (name: string, args: Record<string, unknown>) => Promise<{ data?: unknown; error?: { message: string; code?: string } | null }> = async () => ({
    data: null,
    error: null,
  })
) {
  return {
    from: (table: string) => ({
      select: () => makeQueryBuilder(tables[table] ?? []),
    }),
    rpc: (name: string, args: Record<string, unknown>) => rpcImpl(name, args),
  } as never;
}

const HOTEL_ID = "hotel-a";

describe("getSpaAvailability", () => {
  it("[disabled] no settings row -> enabled: false, no slots", async () => {
    const { getSpaAvailability } = await import("./booking");
    const supabase = makeFakeSupabase({ hotel_spa_settings: [] });

    const result = await getSpaAvailability(HOTEL_ID, "2026-09-15", supabase);
    expect(result).toEqual({ enabled: false, date: "2026-09-15", pricePerPerson: null, allowNonResidents: false, approvalMode: "auto", slots: [] });
  });

  it("[disabled explicitly] enabled: false row also degrades to no slots", async () => {
    const { getSpaAvailability } = await import("./booking");
    const supabase = makeFakeSupabase({
      hotel_spa_settings: [{ hotel_id: HOTEL_ID, enabled: false, opens_at: "10:00", closes_at: "20:00", slot_duration_minutes: 120, capacity_per_slot: 4, price_per_person: 30, allow_non_residents: true, advance_booking_days: 30, min_notice_hours: 2 }],
    });

    const result = await getSpaAvailability(HOTEL_ID, "2026-09-15", supabase);
    expect(result.enabled).toBe(false);
  });

  it("[slots derived from slot_duration_minutes — never a hardcoded duration] a 30-minute configuration on a 09:00-09:30 window produces exactly one 30-minute slot", async () => {
    const { getSpaAvailability } = await import("./booking");
    const supabase = makeFakeSupabase({
      hotel_spa_settings: [{ hotel_id: HOTEL_ID, enabled: true, approval_mode: "auto", opens_at: "09:00", closes_at: "09:30", slot_duration_minutes: 30, capacity_per_slot: 2, price_per_person: null, allow_non_residents: true, advance_booking_days: 30, min_notice_hours: 0 }],
      spa_bookings: [],
    });

    const result = await getSpaAvailability(HOTEL_ID, "2026-09-15", supabase, Date.parse("2026-09-01T00:00:00.000Z"));
    expect(result.slots).toEqual([{ slotStart: "09:00", slotEnd: "09:30", capacity: 2, booked: 0, free: 2, bookable: true }]);
  });

  it("[capacity math] booked party_size reduces free, never goes negative", async () => {
    const { getSpaAvailability } = await import("./booking");
    const supabase = makeFakeSupabase({
      hotel_spa_settings: [{ hotel_id: HOTEL_ID, enabled: true, approval_mode: "auto", opens_at: "10:00", closes_at: "14:00", slot_duration_minutes: 120, capacity_per_slot: 4, price_per_person: 30, allow_non_residents: true, advance_booking_days: 30, min_notice_hours: 0 }],
      spa_bookings: [
        { hotel_id: HOTEL_ID, booking_date: "2026-09-15", status: "confirmed", slot_start: "10:00:00", party_size: 3 },
        { hotel_id: HOTEL_ID, booking_date: "2026-09-15", status: "confirmed", slot_start: "10:00:00", party_size: 2 },
      ],
    });

    const result = await getSpaAvailability(HOTEL_ID, "2026-09-15", supabase, Date.parse("2026-09-01T00:00:00.000Z"));
    const first = result.slots.find((s) => s.slotStart === "10:00");
    expect(first).toMatchObject({ capacity: 4, booked: 5, free: 0, bookable: false });
    const second = result.slots.find((s) => s.slotStart === "12:00");
    expect(second).toMatchObject({ booked: 0, free: 4, bookable: true });
  });

  it("[advance window] a date beyond advance_booking_days is never bookable", async () => {
    const { getSpaAvailability } = await import("./booking");
    const supabase = makeFakeSupabase({
      hotel_spa_settings: [{ hotel_id: HOTEL_ID, enabled: true, approval_mode: "auto", opens_at: "10:00", closes_at: "12:00", slot_duration_minutes: 120, capacity_per_slot: 4, price_per_person: null, allow_non_residents: true, advance_booking_days: 5, min_notice_hours: 0 }],
      spa_bookings: [],
    });

    const nowMs = Date.parse("2026-09-01T00:00:00.000Z");
    const result = await getSpaAvailability(HOTEL_ID, "2026-09-10", supabase, nowMs); // 9 days out, advance = 5
    expect(result.slots[0].bookable).toBe(false);
  });

  it("[min notice] a same-day slot starting sooner than min_notice_hours is never bookable", async () => {
    const { getSpaAvailability } = await import("./booking");
    const supabase = makeFakeSupabase({
      hotel_spa_settings: [{ hotel_id: HOTEL_ID, enabled: true, approval_mode: "auto", opens_at: "10:00", closes_at: "14:00", slot_duration_minutes: 120, capacity_per_slot: 4, price_per_person: null, allow_non_residents: true, advance_booking_days: 30, min_notice_hours: 3 }],
      spa_bookings: [],
    });

    // "now" is 2026-09-15T09:00Z — the 10:00 slot starts in 1h, less than the 3h min notice.
    const nowMs = Date.parse("2026-09-15T09:00:00.000Z");
    const result = await getSpaAvailability(HOTEL_ID, "2026-09-15", supabase, nowMs);
    expect(result.slots.find((s) => s.slotStart === "10:00")?.bookable).toBe(false);
    expect(result.slots.find((s) => s.slotStart === "12:00")?.bookable).toBe(true);
  });
});

describe("createSpaBookingForChatbot", () => {
  const BASE_PARAMS = {
    hotelId: HOTEL_ID,
    conversationId: "conv-1",
    guestName: "Marie",
    guestPhoneE164: "+33612345678",
    partySize: 2,
    isNonResident: false,
    notes: null,
    bookingDate: "2026-09-15",
    slotStart: "10:00",
  };

  it("[success] returns the new booking id and status, and attempts owner notification", async () => {
    const { createSpaBookingForChatbot } = await import("./booking");
    const supabase = makeFakeSupabase(
      {
        hotels: [{ id: HOTEL_ID, name: "Hôtel Test", email: "contact@hotel.test" }],
        chatbot_settings: [{ hotel_id: HOTEL_ID, handoff_email: null }],
        spa_bookings: [{ id: "booking-1", status: "confirmed" }],
      },
      async (name) => (name === "create_spa_booking" ? { data: "booking-1", error: null } : { data: null, error: null })
    );

    const result = await createSpaBookingForChatbot(BASE_PARAMS, supabase);
    expect(result).toEqual({ ok: true, bookingId: "booking-1", status: "confirmed" });
    expect(mockDeliverSpaBookingApprovalRequest).not.toHaveBeenCalled();
  });

  it("[manual approval mode] status pending_approval triggers the WhatsApp approval delivery, best-effort", async () => {
    mockDeliverSpaBookingApprovalRequest.mockClear();
    const { createSpaBookingForChatbot } = await import("./booking");
    const supabase = makeFakeSupabase(
      {
        hotels: [{ id: HOTEL_ID, name: "Hôtel Test", email: "contact@hotel.test" }],
        chatbot_settings: [{ hotel_id: HOTEL_ID, handoff_email: null }],
        spa_bookings: [{ id: "booking-1", status: "pending_approval" }],
      },
      async (name) => (name === "create_spa_booking" ? { data: "booking-1", error: null } : { data: null, error: null })
    );

    const result = await createSpaBookingForChatbot(BASE_PARAMS, supabase);
    expect(result).toEqual({ ok: true, bookingId: "booking-1", status: "pending_approval" });
    expect(mockDeliverSpaBookingApprovalRequest).toHaveBeenCalledWith("booking-1", HOTEL_ID, { supabase });
  });

  it("[manual approval mode] a WhatsApp delivery failure never fails the booking itself", async () => {
    mockDeliverSpaBookingApprovalRequest.mockClear();
    mockDeliverSpaBookingApprovalRequest.mockRejectedValueOnce(new Error("provider down"));
    const { createSpaBookingForChatbot } = await import("./booking");
    const supabase = makeFakeSupabase(
      {
        hotels: [{ id: HOTEL_ID, name: "Hôtel Test", email: "contact@hotel.test" }],
        chatbot_settings: [{ hotel_id: HOTEL_ID, handoff_email: null }],
        spa_bookings: [{ id: "booking-1", status: "pending_approval" }],
      },
      async (name) => (name === "create_spa_booking" ? { data: "booking-1", error: null } : { data: null, error: null })
    );

    const result = await createSpaBookingForChatbot(BASE_PARAMS, supabase);
    expect(result).toEqual({ ok: true, bookingId: "booking-1", status: "pending_approval" });
  });

  it("[slot_full] SQLSTATE P1006 maps to code 'slot_full'", async () => {
    const { createSpaBookingForChatbot } = await import("./booking");
    const supabase = makeFakeSupabase({}, async () => ({ data: null, error: { message: "this slot is fully booked", code: "P1006" } }));

    const result = await createSpaBookingForChatbot(BASE_PARAMS, supabase);
    expect(result).toEqual({ ok: false, code: "slot_full" });
  });

  it("[not_enabled] SQLSTATE P1001 maps to code 'not_enabled'", async () => {
    const { createSpaBookingForChatbot } = await import("./booking");
    const supabase = makeFakeSupabase({}, async () => ({ data: null, error: { message: "spa booking not enabled", code: "P1001" } }));

    const result = await createSpaBookingForChatbot(BASE_PARAMS, supabase);
    expect(result).toEqual({ ok: false, code: "not_enabled" });
  });

  it("[idempotent retry] 23505 re-reads and reuses the existing confirmed booking instead of erroring", async () => {
    const { createSpaBookingForChatbot } = await import("./booking");
    const supabase = makeFakeSupabase(
      { spa_bookings: [{ id: "existing-booking", conversation_id: "conv-1", booking_date: "2026-09-15", slot_start: "10:00", status: "confirmed" }] },
      async () => ({ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } })
    );

    const result = await createSpaBookingForChatbot(BASE_PARAMS, supabase);
    expect(result).toEqual({ ok: true, bookingId: "existing-booking", status: "confirmed" });
  });

  it("[unknown error] any other SQLSTATE degrades to a generic 'error' code, never throws", async () => {
    const { createSpaBookingForChatbot } = await import("./booking");
    const supabase = makeFakeSupabase({}, async () => ({ data: null, error: { message: "unexpected", code: "XXYYY" } }));

    const result = await createSpaBookingForChatbot(BASE_PARAMS, supabase);
    expect(result).toEqual({ ok: false, code: "error" });
  });
});
