import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * PARITÉ PHOTOS ChatPreview chantier — getSelectedRoomPhotosBackoffice/Client
 * are READ-ONLY (no revalidatePath, unlike every write action above), so
 * unlike them these two CAN be real-invocation tested (same discipline as
 * features/partners/actions.test.ts's own requireHotelAccess mock, and as
 * app/api/widget/[widgetKey]/room-photos/route.test.ts's fake Supabase for
 * the exact same query shape this reuses via loadSelectedRoomPhotos).
 */
const mockRequireHotelAccess = vi.fn<(hotelId: string, scope: string) => Promise<{ userId: string; profile: { id: string; role: string }; supabase: unknown }>>(
  async () => ({ userId: "user-1", profile: { id: "user-1", role: "superadmin" }, supabase: null })
);
vi.mock("@/lib/auth/session", () => ({
  requireHotelAccess: (hotelId: string, scope: string) => mockRequireHotelAccess(hotelId, scope),
}));

const mockCreateAdminClient = vi.fn<() => SupabaseClient>();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

afterEach(() => {
  mockRequireHotelAccess.mockClear();
  mockCreateAdminClient.mockReset();
});

/** Chainable fake — .eq() returns itself any number of times, .maybeSingle()/.order() resolve the given result, regardless of chain length/shape (same helper shape as room-photos/route.test.ts's own). */
function chainable(result: unknown) {
  const node = {
    eq: () => node,
    order: async () => result,
    maybeSingle: async () => result,
  };
  return node;
}

const HOTEL_ID = "hotel-1";
const VALID_ACCOMMODATION_TYPE_ID = "22222222-2222-4222-a222-222222222222";
const OTHER_HOTEL_ACCOMMODATION_TYPE_ID = "11111111-1111-4111-a111-111111111111";

function fakeSupabase(options: {
  accommodationTypeLookup?: { data: { id: string; name: string; source_url: string | null } | null; error: { message: string } | null };
  hotelLookup?: { data: { booking_url: string | null } | null; error: { message: string } | null };
  roomPhotos?: { data: { photo_url: string; alt_text: string | null }[] | null; error: { message: string } | null };
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === "accommodation_types") return { select: () => chainable(options.accommodationTypeLookup ?? { data: null, error: null }) };
      if (table === "hotels") return { select: () => chainable(options.hotelLookup ?? { data: { booking_url: null }, error: null }) };
      if (table === "room_photos") return { select: () => chainable(options.roomPhotos ?? { data: [], error: null }) };
      throw new Error(`unexpected table in fake: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function defaultFakeSupabase(): SupabaseClient {
  return fakeSupabase({
    accommodationTypeLookup: { data: { id: VALID_ACCOMMODATION_TYPE_ID, name: "Junior Suite", source_url: "https://le1837.example.com/junior-suite" }, error: null },
    hotelLookup: { data: { booking_url: "https://booking.example.com" }, error: null },
    roomPhotos: { data: [{ photo_url: "https://cdn.example.com/1.jpg", alt_text: "Chambre" }], error: null },
  });
}

describe("getSelectedRoomPhotosBackoffice / getSelectedRoomPhotosClient — authorization", () => {
  it("[hardcoded scope, no fallback] each variant calls requireHotelAccess with its own hardcoded scope, never received from a caller", async () => {
    const { getSelectedRoomPhotosBackoffice, getSelectedRoomPhotosClient } = await import("./actions");
    mockCreateAdminClient.mockReturnValue(defaultFakeSupabase());

    await getSelectedRoomPhotosBackoffice(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID);
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(HOTEL_ID, "backoffice");

    await getSelectedRoomPhotosClient(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID);
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith(HOTEL_ID, "client");
  });

  it("[hôtel autorisé -> succès] backoffice, requireHotelAccess resolves normally -> the accommodation lookup proceeds and succeeds", async () => {
    const { getSelectedRoomPhotosBackoffice } = await import("./actions");
    mockCreateAdminClient.mockReturnValue(defaultFakeSupabase());

    const result = await getSelectedRoomPhotosBackoffice(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID);
    expect(result.ok).toBe(true);
  });

  it("[hôtel autorisé -> succès] client, requireHotelAccess resolves normally -> the accommodation lookup proceeds and succeeds", async () => {
    const { getSelectedRoomPhotosClient } = await import("./actions");
    mockCreateAdminClient.mockReturnValue(defaultFakeSupabase());

    const result = await getSelectedRoomPhotosClient(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID);
    expect(result.ok).toBe(true);
  });

  it("[hôtel non autorisé -> refus] a rejected requireHotelAccess (unauthorized/redirect) propagates — the accommodation_types lookup is never reached", async () => {
    const { getSelectedRoomPhotosBackoffice } = await import("./actions");
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));
    const accommodationTypesSpy = vi.fn();
    mockCreateAdminClient.mockReturnValue({ from: accommodationTypesSpy } as unknown as SupabaseClient);

    await expect(getSelectedRoomPhotosBackoffice(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID)).rejects.toThrow();
    expect(accommodationTypesSpy).not.toHaveBeenCalled();
  });

  it("[autre hôtel -> refus] client scope, requireHotelAccess rejects for a hotelId this session isn't linked to — no data ever loaded", async () => {
    const { getSelectedRoomPhotosClient } = await import("./actions");
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));
    const accommodationTypesSpy = vi.fn();
    mockCreateAdminClient.mockReturnValue({ from: accommodationTypesSpy } as unknown as SupabaseClient);

    await expect(getSelectedRoomPhotosClient("other-hotel", VALID_ACCOMMODATION_TYPE_ID)).rejects.toThrow();
    expect(accommodationTypesSpy).not.toHaveBeenCalled();
  });
});

describe("getSelectedRoomPhotosBackoffice / getSelectedRoomPhotosClient — accommodationTypeId validation", () => {
  it("[UUID invalide -> refus] rejected before any DB lookup, never reaches accommodation_types", async () => {
    const { getSelectedRoomPhotosBackoffice } = await import("./actions");
    const accommodationTypesSpy = vi.fn();
    mockCreateAdminClient.mockReturnValue({ from: accommodationTypesSpy } as unknown as SupabaseClient);

    const result = await getSelectedRoomPhotosBackoffice(HOTEL_ID, "not-a-uuid");
    expect(result.ok).toBe(false);
    expect(accommodationTypesSpy).not.toHaveBeenCalled();
  });
});

describe("getSelectedRoomPhotosBackoffice / getSelectedRoomPhotosClient — cross-hotel / inactive guard (TEST security)", () => {
  it("[catégorie d'un autre hôtel -> refus, sans fuite d'information] the lookup is scoped by hotel_id — a not-found row (simulating a different hotel's id) fails, never leaks photos", async () => {
    const { getSelectedRoomPhotosBackoffice } = await import("./actions");
    mockCreateAdminClient.mockReturnValue(fakeSupabase({ accommodationTypeLookup: { data: null, error: null } }));

    const result = await getSelectedRoomPhotosBackoffice(HOTEL_ID, OTHER_HOTEL_ACCOMMODATION_TYPE_ID);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Hébergement introuvable.");
  });

  it("[catégorie inactive -> refus] active=true is part of the lookup filter — same 404-equivalent as an unknown/foreign id, never distinguished", () => {
    expect(source).toMatch(/\.eq\("id", parsedId\.data\)\s*\n\s*\.eq\("hotel_id", hotelId\)\s*\n\s*\.eq\("active", true\)/);
  });

  it("[accommodation_types lookup throws] fails with a clean error, never falls through to loading photos", async () => {
    const { getSelectedRoomPhotosBackoffice } = await import("./actions");
    mockCreateAdminClient.mockReturnValue(fakeSupabase({ accommodationTypeLookup: { data: null, error: { message: "db error" } } }));

    const result = await getSelectedRoomPhotosBackoffice(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID);
    expect(result.ok).toBe(false);
  });
});

describe("getSelectedRoomPhotosBackoffice / getSelectedRoomPhotosClient — photos (reuses loadSelectedRoomPhotos)", () => {
  it("[reuses the shared helper, never a duplicated room_photos query] imports loadSelectedRoomPhotos from features/rag/roomPhotos", () => {
    expect(source).toMatch(/import \{ loadSelectedRoomPhotos, type RoomPhoto \} from "@\/features\/rag\/roomPhotos";/);
    expect(source).toMatch(/const photos = await loadSelectedRoomPhotos\(supabase, hotelId, accommodationType\.id\);/);
  });

  it("[real photos, correct shape] returns accommodationTypeId/name/photos/pageUrl/bookingUrl", async () => {
    const { getSelectedRoomPhotosBackoffice } = await import("./actions");
    mockCreateAdminClient.mockReturnValue(
      fakeSupabase({
        accommodationTypeLookup: { data: { id: VALID_ACCOMMODATION_TYPE_ID, name: "Junior Suite", source_url: "https://le1837.example.com/junior-suite" }, error: null },
        hotelLookup: { data: { booking_url: "https://booking.example.com" }, error: null },
        roomPhotos: {
          data: [
            { photo_url: "https://cdn.example.com/2.jpg", alt_text: "Chambre 2" },
            { photo_url: "https://cdn.example.com/1.jpg", alt_text: "Chambre 1" },
          ],
          error: null,
        },
      })
    );

    const result = await getSelectedRoomPhotosBackoffice(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      accommodationTypeId: VALID_ACCOMMODATION_TYPE_ID,
      name: "Junior Suite",
      pageUrl: "https://le1837.example.com/junior-suite",
      bookingUrl: "https://booking.example.com",
      photos: [
        { url: "https://cdn.example.com/2.jpg", alt: "Chambre 2" },
        { url: "https://cdn.example.com/1.jpg", alt: "Chambre 1" },
      ],
    });
  });

  it("[0 photo = succès] photos: [] is a success, never an error", async () => {
    const { getSelectedRoomPhotosBackoffice } = await import("./actions");
    mockCreateAdminClient.mockReturnValue(
      fakeSupabase({
        accommodationTypeLookup: { data: { id: VALID_ACCOMMODATION_TYPE_ID, name: "Superior", source_url: null }, error: null },
        hotelLookup: { data: { booking_url: null }, error: null },
        roomPhotos: { data: [], error: null },
      })
    );

    const result = await getSelectedRoomPhotosBackoffice(HOTEL_ID, VALID_ACCOMMODATION_TYPE_ID);
    expect(result.ok).toBe(true);
    expect(result.data?.photos).toEqual([]);
    expect(result.data?.pageUrl).toBeNull();
  });

  it("[strictement read-only] never calls .insert/.update/.upsert/.delete inside these two actions", () => {
    const start = source.indexOf("export interface SelectedRoomPhotosResult");
    const block = source.slice(start);
    expect(block).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|revalidatePath\(/);
  });
});

/**
 * Regression guards for the client/superadmin photo-selection actions —
 * Supabase-touching (requireHotelAccess + createAdminClient) AND
 * revalidatePath-calling, which throws "Invariant: static generation store
 * missing" outside a real Next.js request context — same testing
 * constraint as every other Server Action in this repo that calls
 * revalidatePath (see src/features/knowledge/actions.test.ts), checked at
 * the source level only, no real invocation. requireHotelAccess itself
 * (superadmin-any-hotel vs hotel_admin-own-hotel-only) is already
 * exhaustively covered at runtime in src/lib/auth/session.test.ts — not
 * re-tested here.
 *
 * `scope` is NEVER a parameter of any EXPORTED function in this file — same
 * discipline as features/partners/actions.test.ts (see that file's own doc
 * comment for the full reasoning): a client component (PhotosManager.tsx)
 * must never be able to supply or influence which cookie scope a shared
 * action reads. Every exported action is a thin, hardcoded-scope wrapper
 * around a non-exported `*Internal` function.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  // Bounded by whichever comes first: the next exported wrapper, or the
  // next non-exported `*Internal` helper.
  const nextExport = source.indexOf("\nexport async function", start + 1);
  const nextInternal = source.indexOf("\nasync function", start + 1);
  const boundaries = [nextExport, nextInternal].filter((i) => i !== -1);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : undefined;
  return source.slice(start, end);
}

const EXPORTED_FUNCTION_NAMES = [
  "setPhotoSelectionBackoffice",
  "setPhotoSelectionClient",
  "setAccommodationPhotosSelectionBackoffice",
  "setAccommodationPhotosSelectionClient",
];

describe("no exported action ever accepts a scope parameter", () => {
  it("[signature audit] none of the exported functions declares a `scope` parameter", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      const fn = sliceFunction(name);
      const signatureEnd = fn.indexOf("Promise<");
      const signature = fn.slice(0, signatureEnd);
      expect(signature).not.toMatch(/scope/i);
    }
  });

  it("[no AuthScope import surfaces on an exported function]", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      expect(sliceFunction(name)).not.toMatch(/AuthScope/);
    }
  });
});

describe("setPhotoSelectionBackoffice / setPhotoSelectionClient", () => {
  it("[hardcoded scope, no fallback] Backoffice always passes \"backoffice\", Client always passes \"client\" — never received from a caller", () => {
    expect(source).toMatch(/setPhotoSelectionInternal\(hotelId, photoId, isSelected, "backoffice"\)/);
    expect(source).toMatch(/setPhotoSelectionInternal\(hotelId, photoId, isSelected, "client"\)/);
  });

  it("[both roles authorized] guarded by requireHotelAccess — allows superadmin (any hotel) OR the linked hotel_admin, never requireClientAccess/requireSuperadmin alone", () => {
    expect(source).toMatch(/requireHotelAccess\(hotelId, scope\)/);
  });

  it("[tenant isolation] scopes the update by BOTH photo id and hotel_id — a guessed photoId from another hotel can never be touched", () => {
    expect(source).toMatch(/\.eq\("id", photoId\)\.eq\("hotel_id", hotelId\)/);
  });

  it("[writes is_selected only] the update payload is exactly { is_selected: isSelected }", () => {
    expect(source).toMatch(/\.update\(\{ is_selected: isSelected \}\)/);
  });

  it("[service_role, not session-bound] uses createAdminClient() after requireHotelAccess, never the client requireHotelAccess itself resolves", () => {
    expect(source).toMatch(/const supabase = createAdminClient\(\);/);
  });
});

describe("setAccommodationPhotosSelectionBackoffice / setAccommodationPhotosSelectionClient", () => {
  it("[hardcoded scope, no fallback]", () => {
    expect(source).toMatch(/setAccommodationPhotosSelectionInternal\(hotelId, accommodationTypeId, isSelected, "backoffice"\)/);
    expect(source).toMatch(/setAccommodationPhotosSelectionInternal\(hotelId, accommodationTypeId, isSelected, "client"\)/);
  });

  it("[both roles authorized] guarded by requireHotelAccess", () => {
    expect(source).toMatch(/requireHotelAccess\(hotelId, scope\)/);
  });

  it("[tenant isolation] scopes the bulk update by BOTH hotel_id and accommodation_type_id", () => {
    expect(source).toMatch(/\.eq\("hotel_id", hotelId\)/);
    expect(source).toMatch(/\.eq\("accommodation_type_id", accommodationTypeId\)/);
  });
});
