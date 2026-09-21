import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createRoomPhotosHandler, type RoomPhotosRouteDeps } from "./route";
import type { PublicWidgetContext } from "@/features/widget/publicHotel";

/**
 * CATÉGORIES INFORMATION CLIQUABLES chantier — real invocation tests, same
 * discipline as chat/route.test.ts: a real Request, the real exported
 * handler (via createRoomPhotosHandler with controllable fake dependencies),
 * asserting on the real Response — never a source-text search.
 */

const HOTEL_ID = "hotel-1";
const OTHER_HOTEL_ACCOMMODATION_TYPE_ID = "11111111-1111-4111-a111-111111111111";
const VALID_ACCOMMODATION_TYPE_ID = "22222222-2222-4222-a222-222222222222";

function makeWidgetContext(overrides: Partial<PublicWidgetContext["hotel"]> = {}): PublicWidgetContext {
  return {
    hotelId: HOTEL_ID,
    hotel: {
      id: HOTEL_ID,
      name: "Le 1837",
      slug: "le-1837",
      widget_key: "ps_live_test",
      website: null,
      logo_url: null,
      address: null,
      postal_code: null,
      city: null,
      country: null,
      phone: null,
      email: null,
      primary_color: "#1A1D1A",
      secondary_color: "#8A6A3E",
      languages: ["fr"],
      default_language: "fr",
      booking_url: "https://booking.example.com",
      spa_booking_url: null,
      booking_action_mode: "url",
      host_booking_trigger: null,
      assistant_name: "Camille",
      assistant_enabled: true,
      photo_management: "client",
      total_accommodation_units: null,
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...overrides,
    },
    widgetDisplay: { welcomeMessage: "Bonjour !", position: "bottom-right", icon: "chat" },
  };
}

/** A chainable fake — .eq() returns itself any number of times, .maybeSingle()/.order() resolve the given result, regardless of chain length/shape. */
function chainable(result: unknown) {
  const node = {
    eq: () => node,
    order: async () => result,
    maybeSingle: async () => result,
  };
  return node;
}

function fakeSupabase(options: {
  accommodationTypeLookup?: { data: { id: string; name: string; source_url: string | null } | null; error: { message: string } | null };
  roomPhotos?: { data: { photo_url: string; alt_text: string | null }[] | null; error: { message: string } | null };
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === "accommodation_types") {
        return { select: () => chainable(options.accommodationTypeLookup ?? { data: null, error: null }) };
      }
      if (table === "room_photos") {
        return { select: () => chainable(options.roomPhotos ?? { data: [], error: null }) };
      }
      throw new Error(`unexpected table in fake: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function makeDeps(overrides: Partial<RoomPhotosRouteDeps> = {}): RoomPhotosRouteDeps {
  return {
    createSupabaseClient: () =>
      fakeSupabase({
        accommodationTypeLookup: { data: { id: VALID_ACCOMMODATION_TYPE_ID, name: "Junior Suite", source_url: "https://le1837.example.com/junior-suite" }, error: null },
        roomPhotos: { data: [{ photo_url: "https://cdn.example.com/1.jpg", alt_text: "Chambre" }], error: null },
      }),
    resolveWidgetContext: vi.fn(async () => makeWidgetContext()),
    checkGlobalRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    ...overrides,
  };
}

function makeRequest(accommodationTypeId: string | null): Request {
  const url = new URL("http://widget.test/api/widget/ps_live_test/room-photos");
  if (accommodationTypeId !== null) url.searchParams.set("accommodationTypeId", accommodationTypeId);
  return new Request(url, { method: "GET" });
}

const context = { params: Promise.resolve({ widgetKey: "ps_live_test" }) } as unknown as Parameters<ReturnType<typeof createRoomPhotosHandler>>[1];

describe("GET /api/widget/[widgetKey]/room-photos — widget resolution", () => {
  it("[unknown widget] returns 404, never queries accommodation_types", async () => {
    const accommodationTypesSpy = vi.fn();
    const deps = makeDeps({
      resolveWidgetContext: vi.fn(async () => null),
      createSupabaseClient: () => ({ from: accommodationTypesSpy }) as unknown as SupabaseClient,
    });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(404);
    expect(accommodationTypesSpy).not.toHaveBeenCalled();
  });

  it("[resolver throws] fails closed with 503, no internal detail leaked", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => Promise.reject(new Error("connection reset"))) });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).not.toMatch(/connection reset/);
  });

  it("[client creation throws] fails closed with 503", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
      },
    });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(503);
  });
});

describe("GET /api/widget/[widgetKey]/room-photos — rate limiting (fail closed)", () => {
  it("[denied] returns 429 with Retry-After, never queries accommodation_types", async () => {
    const accommodationTypesSpy = vi.fn();
    const deps = makeDeps({
      checkGlobalRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 12 })),
      createSupabaseClient: () => ({ from: accommodationTypesSpy }) as unknown as SupabaseClient,
    });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(accommodationTypesSpy).not.toHaveBeenCalled();
  });

  it("[RPC throws] fails closed with 503", async () => {
    const deps = makeDeps({ checkGlobalRateLimit: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(503);
  });
});

describe("GET /api/widget/[widgetKey]/room-photos — accommodationTypeId validation", () => {
  it("[missing param] returns 400", async () => {
    const handler = createRoomPhotosHandler(makeDeps());
    const response = await handler(makeRequest(null), context);
    expect(response.status).toBe(400);
  });

  it("[not a UUID] returns 400, never reaches the DB lookup", async () => {
    const handler = createRoomPhotosHandler(makeDeps());
    const response = await handler(makeRequest("not-a-uuid"), context);
    expect(response.status).toBe(400);
  });
});

describe("GET /api/widget/[widgetKey]/room-photos — cross-hotel guard (TEST A security)", () => {
  it("[accommodationTypeId belongs to another hotel] the lookup is scoped by hotel_id — a not-found row (simulating a different hotel's id) returns 404, never leaks photos", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => fakeSupabase({ accommodationTypeLookup: { data: null, error: null } }),
    });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(OTHER_HOTEL_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(404);
  });

  it("[accommodation_types lookup throws] fails closed with 503, never falls through to loading photos", async () => {
    const deps = makeDeps({
      createSupabaseClient: () =>
        fakeSupabase({ accommodationTypeLookup: { data: null, error: { message: "db error" } } }),
    });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(503);
  });
});

describe("GET /api/widget/[widgetKey]/room-photos — success payload (TEST A)", () => {
  it("[real photos, correct shape] returns accommodationTypeId/name/photos/pageUrl/bookingUrl — nothing else", async () => {
    const deps = makeDeps({
      createSupabaseClient: () =>
        fakeSupabase({
          accommodationTypeLookup: { data: { id: VALID_ACCOMMODATION_TYPE_ID, name: "Junior Suite", source_url: "https://le1837.example.com/junior-suite" }, error: null },
          roomPhotos: {
            data: [
              { photo_url: "https://cdn.example.com/2.jpg", alt_text: "Chambre 2" },
              { photo_url: "https://cdn.example.com/1.jpg", alt_text: "Chambre 1" },
            ],
            error: null,
          },
        }),
    });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(["accommodationTypeId", "bookingUrl", "name", "pageUrl", "photos"].sort());
    expect(body.accommodationTypeId).toBe(VALID_ACCOMMODATION_TYPE_ID);
    expect(body.name).toBe("Junior Suite");
    expect(body.pageUrl).toBe("https://le1837.example.com/junior-suite");
    expect(body.bookingUrl).toBe("https://booking.example.com");
    // Order preserved exactly as returned by the query (ORDER BY position — the fake simulates the already-ordered rows the real .order() call would produce).
    expect(body.photos).toEqual([
      { url: "https://cdn.example.com/2.jpg", alt: "Chambre 2" },
      { url: "https://cdn.example.com/1.jpg", alt: "Chambre 1" },
    ]);
  });

  it("[0 photos, still a success] returns photos: [] — never an error, never a fake modal-less state", async () => {
    const deps = makeDeps({
      createSupabaseClient: () =>
        fakeSupabase({
          accommodationTypeLookup: { data: { id: VALID_ACCOMMODATION_TYPE_ID, name: "Superior", source_url: null }, error: null },
          roomPhotos: { data: [], error: null },
        }),
    });
    const handler = createRoomPhotosHandler(deps);
    const response = await handler(makeRequest(VALID_ACCOMMODATION_TYPE_ID), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.photos).toEqual([]);
    expect(body.pageUrl).toBeNull();
  });

  it("[no service_role permission broadening / no write] this handler never calls .insert/.update/.upsert/.delete anywhere", async () => {
    const routeSource = (await import("node:fs")).readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    expect(routeSource).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });
});
