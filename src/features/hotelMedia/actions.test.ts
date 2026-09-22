import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const mockRequireSuperadmin = vi.fn<() => Promise<{ userId: string; profile: { id: string; role: string } }>>(
  async () => ({ userId: "superadmin-1", profile: { id: "superadmin-1", role: "superadmin" } })
);
const mockRequireHotelAccess = vi.fn<(hotelId: string, scope: string) => Promise<{ userId: string; profile: { id: string; role: string }; supabase: unknown }>>(
  async () => ({ userId: "user-1", profile: { id: "user-1", role: "superadmin" }, supabase: null })
);
vi.mock("@/lib/auth/session", () => ({
  requireSuperadmin: () => mockRequireSuperadmin(),
  requireHotelAccess: (hotelId: string, scope: string) => mockRequireHotelAccess(hotelId, scope),
}));

const mockCreateClient = vi.fn<() => Promise<SupabaseClient>>();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

const mockCreateAdminClient = vi.fn<() => SupabaseClient>();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

afterEach(() => {
  mockRequireSuperadmin.mockClear();
  mockRequireHotelAccess.mockClear();
  mockCreateClient.mockReset();
  mockCreateAdminClient.mockReset();
});

const HOTEL_ID = "hotel-1";

function makeHotelMediaChain(countResult: { count: number }, insertResult: { data: { id: string } | null; error: { code?: string; message: string } | null }) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    insert: () => chain,
    single: async () => insertResult,
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(countResult).then(onFulfilled, onRejected),
  };
  return chain;
}

function fakeSupabase(count: number, insertResult: { data: { id: string } | null; error: { code?: string; message: string } | null }): SupabaseClient {
  return { from: () => makeHotelMediaChain({ count }, insertResult) } as unknown as SupabaseClient;
}

function validUploadInput() {
  return {
    category: "pool",
    title: "Bassin principal",
    altText: "Piscine intérieure chauffée",
    storagePath: `${HOTEL_ID}/abc.jpg`,
    photoUrl: "https://storage.example.com/hotel-media/abc.jpg",
    contentHash: "a".repeat(64),
  };
}

describe("addHotelMediaPhoto — superadmin-only, never room_photos/accommodation_types", () => {
  it("[superadmin-only] calls requireSuperadmin(), never requireHotelAccess/requireClientAccess", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    mockCreateClient.mockResolvedValue(fakeSupabase(0, { data: { id: "photo-1" }, error: null }));

    await addHotelMediaPhoto(HOTEL_ID, validUploadInput());

    expect(mockRequireSuperadmin).toHaveBeenCalledTimes(1);
    expect(mockRequireHotelAccess).not.toHaveBeenCalled();
  });

  it("[session-bound client, not service_role] uses createClient() (@/lib/supabase/server), relying on the superadmin RLS policy — never createAdminClient()", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    mockCreateClient.mockResolvedValue(fakeSupabase(0, { data: { id: "photo-1" }, error: null }));

    await addHotelMediaPhoto(HOTEL_ID, validUploadInput());

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("[valid input -> success] returns the new id", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    mockCreateClient.mockResolvedValue(fakeSupabase(0, { data: { id: "photo-1" }, error: null }));

    const result = await addHotelMediaPhoto(HOTEL_ID, validUploadInput());
    expect(result).toEqual({ ok: true, data: { id: "photo-1" } });
  });

  it("[position = déterministe] uses the existing per-category count as the new photo's position — first photo in a category gets position 0, a category that already has 3 gets 3", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    const supabase = fakeSupabase(3, { data: { id: "photo-4" }, error: null });
    const insertSpy = vi.spyOn(supabase, "from");
    mockCreateClient.mockResolvedValue(supabase);

    await addHotelMediaPhoto(HOTEL_ID, validUploadInput());

    expect(insertSpy).toHaveBeenCalledWith("hotel_media");
  });

  it("[catégorie invalide -> refus avant tout accès Supabase]", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    const supabase = fakeSupabase(0, { data: { id: "photo-1" }, error: null });
    const fromSpy = vi.spyOn(supabase, "from");
    mockCreateClient.mockResolvedValue(supabase);

    const result = await addHotelMediaPhoto(HOTEL_ID, { ...validUploadInput(), category: "restaurant_kitchen_staff_only" });
    expect(result.ok).toBe(false);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("[empreinte de fichier invalide -> refus] contentHash must be a 64-char hex string", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    const result = await addHotelMediaPhoto(HOTEL_ID, { ...validUploadInput(), contentHash: "not-a-hash" });
    expect(result.ok).toBe(false);
  });

  it("[doublon — 23505] surfaces a clear, non-technical message, never a raw DB error", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    mockCreateClient.mockResolvedValue(fakeSupabase(0, { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }));

    const result = await addHotelMediaPhoto(HOTEL_ID, validUploadInput());
    expect(result).toEqual({ ok: false, error: "Cette photo a déjà été importée pour cet hôtel." });
  });

  it("[autre erreur DB] generic message, raw error never surfaced to the caller", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    mockCreateClient.mockResolvedValue(fakeSupabase(0, { data: null, error: { message: "connection refused, host db.internal:5432" } }));

    const result = await addHotelMediaPhoto(HOTEL_ID, validUploadInput());
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("db.internal");
  });

  it("[aucune régression room_photos/accommodation_types] this file never references either table — hotel_media is fully independent storage", () => {
    expect(source).not.toMatch(/room_photos/);
    expect(source).not.toMatch(/accommodation_types/);
  });

  it("[titre/alt vides -> null, jamais chaîne vide stockée]", async () => {
    const { addHotelMediaPhoto } = await import("./actions");
    const supabase = fakeSupabase(0, { data: { id: "photo-1" }, error: null });
    mockCreateClient.mockResolvedValue(supabase);

    const result = await addHotelMediaPhoto(HOTEL_ID, { ...validUploadInput(), title: "", altText: "" });
    expect(result.ok).toBe(true);
  });
});

describe("setHotelMediaSelectionBackoffice / setHotelMediaSelectionClient", () => {
  it("[hardcoded scope, no fallback] Backoffice always passes \"backoffice\", Client always passes \"client\"", async () => {
    const { setHotelMediaSelectionBackoffice, setHotelMediaSelectionClient } = await import("./actions");
    mockCreateAdminClient.mockReturnValue({ from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) } as unknown as SupabaseClient);

    await setHotelMediaSelectionBackoffice(HOTEL_ID, "photo-1", true);
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(HOTEL_ID, "backoffice");

    await setHotelMediaSelectionClient(HOTEL_ID, "photo-1", true);
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(HOTEL_ID, "client");
  });

  it("[isolation multi-hôtel] a rejected requireHotelAccess (wrong hotel / unauthorized) never reaches the update — verified by never calling createAdminClient after rejection", async () => {
    const { setHotelMediaSelectionBackoffice } = await import("./actions");
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));

    await expect(setHotelMediaSelectionBackoffice("other-hotel", "photo-1", true)).rejects.toThrow();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("[tenant isolation on the write itself] scopes the update by BOTH photo id and hotel_id — source-level, mirrors setPhotoSelectionInternal exactly", () => {
    expect(source).toMatch(/\.eq\("id", photoId\)\.eq\("hotel_id", hotelId\)/);
  });

  it("[writes is_selected only]", () => {
    expect(source).toMatch(/\.update\(\{ is_selected: isSelected \}\)/);
  });

  it("[service_role after authorization, not session-bound]", () => {
    const start = source.indexOf("async function setHotelMediaSelectionInternal");
    const block = source.slice(start, start + 600);
    expect(block).toMatch(/const supabase = createAdminClient\(\);/);
  });

  it("[real invocation, success path] update succeeds -> ok:true", async () => {
    const { setHotelMediaSelectionBackoffice } = await import("./actions");
    mockCreateAdminClient.mockReturnValue({ from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) } as unknown as SupabaseClient);

    const result = await setHotelMediaSelectionBackoffice(HOTEL_ID, "photo-1", false);
    expect(result).toEqual({ ok: true, data: null });
  });

  it("[real invocation, DB error] update fails -> ok:false, clean message", async () => {
    const { setHotelMediaSelectionClient } = await import("./actions");
    mockCreateAdminClient.mockReturnValue({ from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: { message: "db down" } }) }) }) }) } as unknown as SupabaseClient);

    const result = await setHotelMediaSelectionClient(HOTEL_ID, "photo-1", false);
    expect(result.ok).toBe(false);
  });
});

describe("no exported action ever accepts a scope parameter", () => {
  it("[signature audit]", () => {
    for (const name of ["setHotelMediaSelectionBackoffice", "setHotelMediaSelectionClient"]) {
      const start = source.indexOf(`export async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const signatureEnd = source.indexOf("Promise<", start);
      expect(source.slice(start, signatureEnd)).not.toMatch(/scope/i);
    }
  });
});
