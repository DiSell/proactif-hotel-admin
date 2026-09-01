import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * Records every call made on the fake Supabase client (table + method +
 * args) so tests can assert on the EXACT filter chain (tenant isolation),
 * not just the final outcome — same discipline as
 * features/partners/actions.test.ts's own fakeChainableSupabase, but
 * tracking calls since this file's own tests need to assert on
 * .eq("hotel_id", ...) specifically.
 */
function fakeChainableSupabase(overrides: { insertError?: { message: string }; updateError?: { message: string }; deleteError?: { message: string } } = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const chain: Record<string, unknown> = {
    insert: (...args: unknown[]) => {
      calls.push({ method: "insert", args });
      return chain;
    },
    update: (...args: unknown[]) => {
      calls.push({ method: "update", args });
      return chain;
    },
    delete: (...args: unknown[]) => {
      calls.push({ method: "delete", args });
      return chain;
    },
    select: (...args: unknown[]) => {
      calls.push({ method: "select", args });
      return chain;
    },
    eq: (...args: unknown[]) => {
      calls.push({ method: "eq", args });
      return chain;
    },
    single: async () => (overrides.insertError ? { data: null, error: overrides.insertError } : { data: { id: "event-1" }, error: null }),
  };
  // update()/delete() resolve directly off .eq().eq() in this file (no
  // .single() call) — a plain (non-Promise) object awaits to itself.
  Object.assign(chain, { data: null, error: overrides.updateError ?? overrides.deleteError ?? null });
  return { supabase: { from: () => chain }, calls };
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
const EVENT_ID = "event-1";

const VALID_TEMPORARY_INPUT = {
  type: "temporary" as const,
  title: "Fermeture spa",
  content: "Fermé pour travaux.",
  starts_at: "2026-09-12",
  ends_at: "2026-09-18",
  is_active: true,
  show_as_banner: false,
};

describe("events/actions.ts — structural guarantees", () => {
  it("[no scope parameter on any exported action] scope is always hardcoded at the export, never received from a caller", () => {
    const exportedFns = source.match(/export async function \w+\([^)]*\)/g) ?? [];
    expect(exportedFns.length).toBeGreaterThan(0);
    for (const signature of exportedFns) {
      expect(signature).not.toMatch(/scope/);
    }
  });

  it("[only the client scope is exported today] matches the task's own scope (\"l'espace de configuration du client\") — no admin/backoffice UI for events exists yet", () => {
    expect(source).toMatch(/createHotelEventInternal\(hotelId, input, \"client\"\)/);
    expect(source).toMatch(/updateHotelEventInternal\(hotelId, eventId, input, \"client\"\)/);
    expect(source).toMatch(/setHotelEventActiveInternal\(hotelId, eventId, isActive, \"client\"\)/);
    expect(source).toMatch(/deleteHotelEventInternal\(hotelId, eventId, \"client\"\)/);
    expect(source).not.toMatch(/"backoffice"/);
  });

  it("[writes through the session-bound client] never createAdminClient/service_role — RLS (0032_hotel_events.sql) is the real gate", () => {
    expect(source).not.toMatch(/createAdminClient/);
  });
});

describe("createHotelEventClient", () => {
  it("[calls requireHotelAccess with \"client\"] before any write", async () => {
    const { supabase } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { createHotelEventClient } = await import("./actions");

    await createHotelEventClient(HOTEL_ID, VALID_TEMPORARY_INPUT);
    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "client");
  });

  it("[tenant isolation] the inserted row carries hotel_id — never inferred from the input alone", async () => {
    const { supabase, calls } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { createHotelEventClient } = await import("./actions");

    const result = await createHotelEventClient(HOTEL_ID, VALID_TEMPORARY_INPUT);
    expect(result.ok).toBe(true);
    const insertCall = calls.find((c) => c.method === "insert");
    expect((insertCall?.args[0] as { hotel_id: string }).hotel_id).toBe(HOTEL_ID);
  });

  it("[validation] invalid input (missing title) never reaches the database", async () => {
    const { supabase, calls } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { createHotelEventClient } = await import("./actions");

    const result = await createHotelEventClient(HOTEL_ID, { ...VALID_TEMPORARY_INPUT, title: "" });
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.title).toBeTruthy();
    expect(calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("[insert failure] clean ActionResult, never a raw throw", async () => {
    const { supabase } = fakeChainableSupabase({ insertError: { message: "constraint violation" } });
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { createHotelEventClient } = await import("./actions");

    const result = await createHotelEventClient(HOTEL_ID, VALID_TEMPORARY_INPUT);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/constraint violation/);
  });
});

describe("updateHotelEventClient", () => {
  it("[tenant isolation] scoped by BOTH eventId and hotel_id — a guessed eventId from another hotel can never be updated", async () => {
    const { supabase, calls } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { updateHotelEventClient } = await import("./actions");

    await updateHotelEventClient(HOTEL_ID, EVENT_ID, VALID_TEMPORARY_INPUT);
    const eqCalls = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqCalls).toContainEqual(["id", EVENT_ID]);
    expect(eqCalls).toContainEqual(["hotel_id", HOTEL_ID]);
  });

  it("[calls requireHotelAccess with \"client\"]", async () => {
    const { supabase } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { updateHotelEventClient } = await import("./actions");

    await updateHotelEventClient(HOTEL_ID, EVENT_ID, VALID_TEMPORARY_INPUT);
    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "client");
  });
});

describe("setHotelEventActiveClient", () => {
  it("[narrow write] only is_active is written, never any other field", async () => {
    const { supabase, calls } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { setHotelEventActiveClient } = await import("./actions");

    await setHotelEventActiveClient(HOTEL_ID, EVENT_ID, false);
    const updateCall = calls.find((c) => c.method === "update");
    expect(updateCall?.args[0]).toEqual({ is_active: false });
  });

  it("[tenant isolation]", async () => {
    const { supabase, calls } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { setHotelEventActiveClient } = await import("./actions");

    await setHotelEventActiveClient(HOTEL_ID, EVENT_ID, true);
    const eqCalls = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqCalls).toContainEqual(["hotel_id", HOTEL_ID]);
  });
});

describe("deleteHotelEventClient", () => {
  it("[tenant isolation] delete is scoped by BOTH eventId and hotel_id", async () => {
    const { supabase, calls } = fakeChainableSupabase();
    mockRequireHotelAccess.mockResolvedValueOnce({ userId: "u1", profile: { id: "u1", role: "hotel_admin" }, supabase });
    const { deleteHotelEventClient } = await import("./actions");

    await deleteHotelEventClient(HOTEL_ID, EVENT_ID);
    const eqCalls = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqCalls).toContainEqual(["id", EVENT_ID]);
    expect(eqCalls).toContainEqual(["hotel_id", HOTEL_ID]);
  });

  it("[unauthorized caller] requireHotelAccess rejecting stops the chain before any delete call", async () => {
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));
    const { deleteHotelEventClient } = await import("./actions");

    await expect(deleteHotelEventClient("hotel-b", EVENT_ID)).rejects.toThrow();
  });
});
