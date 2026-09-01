import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DEFAULT_SPA_SETTINGS_INPUT } from "./schema";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

function fakeSupabase(overrides: { upsertError?: { message: string }; rpcError?: { message: string; code?: string } } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const fromChain = {
    upsert: (...args: unknown[]) => {
      calls.push({ method: "upsert", args });
      return Promise.resolve(overrides.upsertError ? { error: overrides.upsertError } : { error: null });
    },
  };
  return {
    supabase: {
      from: (...args: unknown[]) => {
        calls.push({ method: "from", args });
        return fromChain;
      },
      rpc: (...args: unknown[]) => {
        calls.push({ method: "rpc", args });
        return Promise.resolve(overrides.rpcError ? { error: overrides.rpcError } : { data: null, error: null });
      },
    },
    calls,
  };
}

const mockRequireHotelAccess = vi.fn<
  (hotelId: string, scope: string) => Promise<{ userId: string; profile: { id: string; role: string }; supabase: unknown }>
>();
vi.mock("@/lib/auth/session", () => ({
  requireHotelAccess: (hotelId: string, scope: string) => mockRequireHotelAccess(hotelId, scope),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

afterEach(() => {
  mockRequireHotelAccess.mockReset();
});

const HOTEL_ID = "hotel-a";
const BOOKING_ID = "booking-1";
const VALID_INPUT = { ...DEFAULT_SPA_SETTINGS_INPUT, enabled: true };

describe("spa/actions.ts — structural guarantees", () => {
  it("[no scope parameter on any exported action] scope is always hardcoded at the export, never received from a caller", () => {
    const exportedFns = source.match(/export async function \w+\([^)]*\)/g) ?? [];
    expect(exportedFns.length).toBeGreaterThan(0);
    for (const signature of exportedFns) {
      expect(signature).not.toMatch(/scope/);
    }
  });

  it("[only the client scope is exported] no back-office spa-settings UI was requested", () => {
    expect(source).toMatch(/upsertHotelSpaSettingsInternal\(hotelId, input, "client"\)/);
    expect(source).toMatch(/cancelSpaBookingInternal\(hotelId, bookingId, "client"\)/);
    expect(source).toMatch(/approveSpaBookingInternal\(hotelId, bookingId, "client"\)/);
    expect(source).not.toMatch(/"backoffice"/);
  });

  it("[settings writes through the session-bound client] never createAdminClient/service_role — RLS (0033_hotel_spa_settings.sql) is the real gate", () => {
    expect(source).not.toMatch(/createAdminClient/);
  });

  it("[cancellation always passes 'hotel' as cancelled_by] the client portal is the only caller of cancel_spa_booking today", () => {
    expect(source).toMatch(/p_cancelled_by: "hotel"/);
  });
});

describe("upsertHotelSpaSettingsClient", () => {
  it("[calls requireHotelAccess with \"client\"]", async () => {
    const { supabase } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { upsertHotelSpaSettingsClient } = await import("./actions");

    await upsertHotelSpaSettingsClient(HOTEL_ID, VALID_INPUT);
    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "client");
  });

  it("[tenant isolation] the upserted row carries hotel_id", async () => {
    const { supabase, calls } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { upsertHotelSpaSettingsClient } = await import("./actions");

    const result = await upsertHotelSpaSettingsClient(HOTEL_ID, VALID_INPUT);
    expect(result.ok).toBe(true);
    const upsertCall = calls.find((c) => c.method === "upsert");
    expect((upsertCall?.args[0] as { hotel_id: string }).hotel_id).toBe(HOTEL_ID);
  });

  it("[upsert is scoped on hotel_id, not a create/update pair]", async () => {
    const { supabase, calls } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { upsertHotelSpaSettingsClient } = await import("./actions");

    await upsertHotelSpaSettingsClient(HOTEL_ID, VALID_INPUT);
    const upsertCall = calls.find((c) => c.method === "upsert");
    expect(upsertCall?.args[1]).toEqual({ onConflict: "hotel_id" });
  });

  it("[validation] a slot duration that doesn't divide the opening window never reaches the database", async () => {
    const { supabase, calls } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { upsertHotelSpaSettingsClient } = await import("./actions");

    const result = await upsertHotelSpaSettingsClient(HOTEL_ID, { ...VALID_INPUT, slot_duration_minutes: 90 });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.slot_duration_minutes).toBeTruthy();
    expect(calls.some((c) => c.method === "upsert")).toBe(false);
  });

  it("[upsert failure] clean ActionResult, never a raw throw", async () => {
    const { supabase } = fakeSupabase({ upsertError: { message: "constraint violation" } });
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { upsertHotelSpaSettingsClient } = await import("./actions");

    const result = await upsertHotelSpaSettingsClient(HOTEL_ID, VALID_INPUT);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/constraint violation/);
  });
});

describe("cancelSpaBookingClient", () => {
  it("[calls requireHotelAccess with \"client\"]", async () => {
    const { supabase } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { cancelSpaBookingClient } = await import("./actions");

    await cancelSpaBookingClient(HOTEL_ID, BOOKING_ID);
    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "client");
  });

  it("[tenant isolation] the RPC call carries both hotel_id and booking_id", async () => {
    const { supabase, calls } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { cancelSpaBookingClient } = await import("./actions");

    await cancelSpaBookingClient(HOTEL_ID, BOOKING_ID);
    const rpcCall = calls.find((c) => c.method === "rpc");
    expect(rpcCall?.args[0]).toBe("cancel_spa_booking");
    expect(rpcCall?.args[1]).toMatchObject({ p_hotel_id: HOTEL_ID, p_booking_id: BOOKING_ID });
  });

  it("[rpc failure] clean ActionResult, never a raw throw", async () => {
    const { supabase } = fakeSupabase({ rpcError: { message: "booking is not in confirmed status", code: "P1008" } });
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { cancelSpaBookingClient } = await import("./actions");

    const result = await cancelSpaBookingClient(HOTEL_ID, BOOKING_ID);
    expect(result.ok).toBe(false);
  });
});

describe("approveSpaBookingClient", () => {
  it("[calls requireHotelAccess with \"client\"]", async () => {
    const { supabase } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { approveSpaBookingClient } = await import("./actions");

    await approveSpaBookingClient(HOTEL_ID, BOOKING_ID);
    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "client");
  });

  it("[tenant isolation] the RPC call carries both hotel_id and booking_id", async () => {
    const { supabase, calls } = fakeSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { approveSpaBookingClient } = await import("./actions");

    await approveSpaBookingClient(HOTEL_ID, BOOKING_ID);
    const rpcCall = calls.find((c) => c.method === "rpc");
    expect(rpcCall?.args[0]).toBe("approve_spa_booking");
    expect(rpcCall?.args[1]).toMatchObject({ p_hotel_id: HOTEL_ID, p_booking_id: BOOKING_ID });
  });

  it("[rpc failure] clean ActionResult, never a raw throw", async () => {
    const { supabase } = fakeSupabase({ rpcError: { message: "spa_booking is not pending approval", code: "P1008" } });
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { approveSpaBookingClient } = await import("./actions");

    const result = await approveSpaBookingClient(HOTEL_ID, BOOKING_ID);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/pending approval/);
  });
});
