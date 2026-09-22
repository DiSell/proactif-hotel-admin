import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

type FakeSession = { userId: string; profile: { id: string; role: string }; supabase: unknown };

const mockRequireHotelAccess = vi.fn<(hotelId: string, scope: string) => Promise<FakeSession>>();
vi.mock("@/lib/auth/session", () => ({
  requireHotelAccess: (hotelId: string, scope: string) => mockRequireHotelAccess(hotelId, scope),
}));

const mockCreateAdminClient = vi.fn<() => SupabaseClient>();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

afterEach(() => {
  mockRequireHotelAccess.mockReset();
  mockCreateAdminClient.mockReset();
});

const HOTEL_ID = "hotel-1";

/** Chainable fake covering both the hotels.photo_management read and the hotel_media count+insert, keyed by table name. */
function makeChain(table: string, tables: Record<string, unknown>): Record<string, unknown> {
  if (table === "hotels") {
    const photoManagement = tables.photoManagement as string | undefined;
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: photoManagement === undefined ? null : { photo_management: photoManagement }, error: null }),
        }),
      }),
    };
  }
  // hotel_media
  const countResult = tables.count as { count: number };
  const insertResult = tables.insertResult as { data: { id: string } | null; error: { code?: string; message: string } | null };
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

function fakeSupabase(opts: { photoManagement?: string; count?: number; insertResult?: { data: { id: string } | null; error: { code?: string; message: string } | null } }): SupabaseClient {
  const tables = {
    photoManagement: opts.photoManagement,
    count: { count: opts.count ?? 0 },
    insertResult: opts.insertResult ?? { data: { id: "photo-1" }, error: null },
  };
  return { from: (table: string) => makeChain(table, tables) } as unknown as SupabaseClient;
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

function mockSession(session: SupabaseClient, role: "superadmin" | "hotel_admin" = "superadmin") {
  mockRequireHotelAccess.mockResolvedValue({ userId: "user-1", profile: { id: "user-1", role }, supabase: session });
}

describe("addHotelMediaPhotoBackoffice — scope hardcoded, superadmin path unchanged", () => {
  it("[scope=\"backoffice\"] always calls requireHotelAccess(hotelId, \"backoffice\")", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    mockSession(fakeSupabase({}));

    await addHotelMediaPhotoBackoffice(HOTEL_ID, validUploadInput());

    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "backoffice");
  });

  it("[écrit via le client de session, jamais service_role] createAdminClient() n'est jamais appelé sur ce chemin", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    mockSession(fakeSupabase({}));

    await addHotelMediaPhotoBackoffice(HOTEL_ID, validUploadInput());

    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("[jamais de vérification photo_management côté backoffice] aucune lecture de hotels lorsqu'on passe par le wrapper backoffice", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    const session = fakeSupabase({ photoManagement: "proactif" });
    const fromSpy = vi.spyOn(session, "from");
    mockSession(session);

    const result = await addHotelMediaPhotoBackoffice(HOTEL_ID, validUploadInput());

    expect(result.ok).toBe(true);
    expect(fromSpy).not.toHaveBeenCalledWith("hotels");
  });

  it("[valid input -> success] returns the new id", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    mockSession(fakeSupabase({ insertResult: { data: { id: "photo-1" }, error: null } }));

    const result = await addHotelMediaPhotoBackoffice(HOTEL_ID, validUploadInput());
    expect(result).toEqual({ ok: true, data: { id: "photo-1" } });
  });

  it("[position = déterministe] uses the existing per-category count as the new photo's position", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    const session = fakeSupabase({ count: 3, insertResult: { data: { id: "photo-4" }, error: null } });
    const fromSpy = vi.spyOn(session, "from");
    mockSession(session);

    await addHotelMediaPhotoBackoffice(HOTEL_ID, validUploadInput());

    expect(fromSpy).toHaveBeenCalledWith("hotel_media");
  });

  it("[catégorie invalide -> refus avant tout accès Supabase]", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    const session = fakeSupabase({});
    const fromSpy = vi.spyOn(session, "from");
    mockSession(session);

    const result = await addHotelMediaPhotoBackoffice(HOTEL_ID, { ...validUploadInput(), category: "restaurant_kitchen_staff_only" });
    expect(result.ok).toBe(false);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("[empreinte de fichier invalide -> refus] contentHash must be a 64-char hex string", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    mockSession(fakeSupabase({}));
    const result = await addHotelMediaPhotoBackoffice(HOTEL_ID, { ...validUploadInput(), contentHash: "not-a-hash" });
    expect(result.ok).toBe(false);
  });

  it("[doublon — 23505] surfaces a clear, non-technical message, never a raw DB error", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    mockSession(fakeSupabase({ insertResult: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } } }));

    const result = await addHotelMediaPhotoBackoffice(HOTEL_ID, validUploadInput());
    expect(result).toEqual({ ok: false, error: "Cette photo a déjà été importée pour cet hôtel." });
  });

  it("[autre erreur DB] generic message, raw error never surfaced to the caller", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    mockSession(fakeSupabase({ insertResult: { data: null, error: { message: "connection refused, host db.internal:5432" } } }));

    const result = await addHotelMediaPhotoBackoffice(HOTEL_ID, validUploadInput());
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain("db.internal");
  });

  it("[titre/alt vides -> null, jamais chaîne vide stockée]", async () => {
    const { addHotelMediaPhotoBackoffice } = await import("./actions");
    mockSession(fakeSupabase({}));

    const result = await addHotelMediaPhotoBackoffice(HOTEL_ID, { ...validUploadInput(), title: "", altText: "" });
    expect(result.ok).toBe(true);
  });

  it("[aucune régression room_photos/accommodation_types] this file never references either table", () => {
    expect(source).not.toMatch(/room_photos/);
    expect(source).not.toMatch(/accommodation_types/);
  });
});

describe("addHotelMediaPhotoClient — gated by hotels.photo_management", () => {
  it("[scope=\"client\"] always calls requireHotelAccess(hotelId, \"client\")", async () => {
    const { addHotelMediaPhotoClient } = await import("./actions");
    mockSession(fakeSupabase({ photoManagement: "client" }), "hotel_admin");
    mockCreateAdminClient.mockReturnValue(fakeSupabase({}));

    await addHotelMediaPhotoClient(HOTEL_ID, validUploadInput());

    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "client");
  });

  it("[hotel_admin + photo_management='client' -> autorisé]", async () => {
    const { addHotelMediaPhotoClient } = await import("./actions");
    mockSession(fakeSupabase({ photoManagement: "client" }), "hotel_admin");
    mockCreateAdminClient.mockReturnValue(fakeSupabase({}));

    const result = await addHotelMediaPhotoClient(HOTEL_ID, validUploadInput());
    expect(result).toEqual({ ok: true, data: { id: "photo-1" } });
  });

  it("[hotel_admin + photo_management='proactif' -> refusé, jamais d'insert]", async () => {
    const { addHotelMediaPhotoClient } = await import("./actions");
    const session = fakeSupabase({ photoManagement: "proactif" });
    const fromSpy = vi.spyOn(session, "from");
    mockSession(session, "hotel_admin");

    const result = await addHotelMediaPhotoClient(HOTEL_ID, validUploadInput());

    expect(result.ok).toBe(false);
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(fromSpy).toHaveBeenCalledWith("hotels");
    expect(fromSpy).not.toHaveBeenCalledWith("hotel_media");
  });

  it("[écrit via service_role, uniquement après autorisation] createAdminClient() appelé seulement quand photo_management='client'", async () => {
    const { addHotelMediaPhotoClient } = await import("./actions");
    mockSession(fakeSupabase({ photoManagement: "client" }), "hotel_admin");
    mockCreateAdminClient.mockReturnValue(fakeSupabase({}));

    await addHotelMediaPhotoClient(HOTEL_ID, validUploadInput());

    expect(mockCreateAdminClient).toHaveBeenCalledTimes(1);
  });

  it("[isolation multi-hôtel] hotelId non autorisé -> requireHotelAccess rejette, jamais d'accès Supabase ensuite", async () => {
    const { addHotelMediaPhotoClient } = await import("./actions");
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));

    await expect(addHotelMediaPhotoClient("other-hotel", validUploadInput())).rejects.toThrow();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("[catégorie invalide -> refus avant toute lecture Supabase]", async () => {
    const { addHotelMediaPhotoClient } = await import("./actions");
    const session = fakeSupabase({ photoManagement: "client" });
    const fromSpy = vi.spyOn(session, "from");
    mockSession(session, "hotel_admin");

    const result = await addHotelMediaPhotoClient(HOTEL_ID, { ...validUploadInput(), category: "restaurant_kitchen_staff_only" });
    expect(result.ok).toBe(false);
    // photo_management is still read first (authorization before validation) — only hotel_media must never be touched.
    expect(fromSpy).not.toHaveBeenCalledWith("hotel_media");
  });

  it("[doublon — 23505] même message clair côté client", async () => {
    const { addHotelMediaPhotoClient } = await import("./actions");
    mockSession(fakeSupabase({ photoManagement: "client", insertResult: { data: null, error: { code: "23505", message: "duplicate" } } }), "hotel_admin");
    mockCreateAdminClient.mockReturnValue(fakeSupabase({ photoManagement: "client", insertResult: { data: null, error: { code: "23505", message: "duplicate" } } }));

    const result = await addHotelMediaPhotoClient(HOTEL_ID, validUploadInput());
    expect(result).toEqual({ ok: false, error: "Cette photo a déjà été importée pour cet hôtel." });
  });
});

describe("no exported action ever accepts a scope parameter", () => {
  it("[signature audit]", () => {
    for (const name of [
      "addHotelMediaPhotoBackoffice",
      "addHotelMediaPhotoClient",
      "setHotelMediaSelectionBackoffice",
      "setHotelMediaSelectionClient",
    ]) {
      const start = source.indexOf(`export async function ${name}`);
      expect(start).toBeGreaterThan(-1);
      const signatureEnd = source.indexOf("Promise<", start);
      expect(source.slice(start, signatureEnd)).not.toMatch(/scope/i);
    }
  });

  it("[wrappers scopés en dur] chaque wrapper passe un littéral, jamais une variable, à addHotelMediaPhotoInternal", () => {
    expect(source).toMatch(/addHotelMediaPhotoInternal\(hotelId, input, "backoffice"\)/);
    expect(source).toMatch(/addHotelMediaPhotoInternal\(hotelId, input, "client"\)/);
  });
});

describe("setHotelMediaSelectionBackoffice / setHotelMediaSelectionClient", () => {
  it("[hardcoded scope, no fallback] Backoffice always passes \"backoffice\", Client always passes \"client\"", async () => {
    const { setHotelMediaSelectionBackoffice, setHotelMediaSelectionClient } = await import("./actions");
    mockRequireHotelAccess.mockResolvedValue({ userId: "user-1", profile: { id: "user-1", role: "superadmin" }, supabase: null });
    mockCreateAdminClient.mockReturnValue({ from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) } as unknown as SupabaseClient);

    await setHotelMediaSelectionBackoffice(HOTEL_ID, "photo-1", true);
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(HOTEL_ID, "backoffice");

    await setHotelMediaSelectionClient(HOTEL_ID, "photo-1", true);
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(HOTEL_ID, "client");
  });

  it("[isolation multi-hôtel] a rejected requireHotelAccess (wrong hotel / unauthorized) never reaches the update", async () => {
    const { setHotelMediaSelectionBackoffice } = await import("./actions");
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));

    await expect(setHotelMediaSelectionBackoffice("other-hotel", "photo-1", true)).rejects.toThrow();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("[tenant isolation on the write itself] scopes the update by BOTH photo id and hotel_id", () => {
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
    mockRequireHotelAccess.mockResolvedValue({ userId: "user-1", profile: { id: "user-1", role: "superadmin" }, supabase: null });
    mockCreateAdminClient.mockReturnValue({ from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }) } as unknown as SupabaseClient);

    const result = await setHotelMediaSelectionBackoffice(HOTEL_ID, "photo-1", false);
    expect(result).toEqual({ ok: true, data: null });
  });

  it("[real invocation, DB error] update fails -> ok:false, clean message", async () => {
    const { setHotelMediaSelectionClient } = await import("./actions");
    mockRequireHotelAccess.mockResolvedValue({ userId: "user-1", profile: { id: "user-1", role: "hotel_admin" }, supabase: null });
    mockCreateAdminClient.mockReturnValue({ from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: { message: "db down" } }) }) }) }) } as unknown as SupabaseClient);

    const result = await setHotelMediaSelectionClient(HOTEL_ID, "photo-1", false);
    expect(result.ok).toBe(false);
  });
});
