import { describe, expect, it, vi } from "vitest";

function fakeSupabase() {
  const from = vi.fn((table: string) => {
    if (table === "hotels") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { photo_management: "client" }, error: null }) }) }) };
    }
    if (table === "accommodation_types") {
      return { select: () => ({ eq: () => ({ order: () => ({ returns: async () => ({ data: [], error: null }) }) }) }) };
    }
    if (table === "room_photos") {
      return { select: () => ({ eq: () => ({ order: () => ({ returns: async () => ({ data: [], error: null }) }) }) }) };
    }
    throw new Error(`unexpected table in fake: ${table}`);
  });
  return { from };
}

/**
 * getPhotosManagerData is shared between the back-office and the client
 * portal (see its own doc comment) — back-office and the client portal use
 * different session cookies (lib/supabase/cookieScope.ts), so this function
 * requires an explicit `supabase` argument (no default, no fallback) — the
 * caller must always hand in the client bound to its own scope.
 */
describe("getPhotosManagerData — required supabase client, no default", () => {
  it("[client provided] uses it directly for every query", async () => {
    const { getPhotosManagerData } = await import("./queries");
    const supabase = fakeSupabase();

    await getPhotosManagerData("hotel-a", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("hotels");
    expect(supabase.from).toHaveBeenCalledWith("accommodation_types");
    expect(supabase.from).toHaveBeenCalledWith("room_photos");
  });
});
