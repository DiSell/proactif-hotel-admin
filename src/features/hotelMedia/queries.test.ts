import { describe, expect, it, vi } from "vitest";
import { HOTEL_MEDIA_CATEGORIES } from "@/types/database";

function fakeSupabase(photos: { id: string; category: string; title: string | null; photo_url: string; alt_text: string | null; is_selected: boolean; position: number }[]) {
  const eqCalls: unknown[][] = [];
  const from = vi.fn((table: string) => {
    if (table !== "hotel_media") throw new Error(`unexpected table in fake: ${table}`);
    return {
      select: () => ({
        eq: (...args: unknown[]) => {
          eqCalls.push(args);
          return { order: () => ({ returns: async () => ({ data: photos, error: null }) }) };
        },
      }),
    };
  });
  return { from, eqCalls };
}

describe("getHotelMediaData", () => {
  it("[toutes les catégories présentes] every category from HOTEL_MEDIA_CATEGORIES appears in the result, even with zero photos — never limited to categories that already have content", async () => {
    const { getHotelMediaData } = await import("./queries");
    const supabase = fakeSupabase([]);

    const data = await getHotelMediaData("hotel-a", supabase as never);

    expect(data.categories.map((c) => c.category)).toEqual([...HOTEL_MEDIA_CATEGORIES]);
    expect(data.categories.every((c) => c.photos.length === 0)).toBe(true);
  });

  it("[isolation hôtel] queries hotel_media filtered by hotel_id", async () => {
    const { getHotelMediaData } = await import("./queries");
    const supabase = fakeSupabase([]);

    await getHotelMediaData("hotel-a", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("hotel_media");
    expect(supabase.eqCalls).toContainEqual(["hotel_id", "hotel-a"]);
  });

  it("[groupement par catégorie, ordre déterministe] photos are grouped under their own category, in the order the query returned them (position ascending)", async () => {
    const { getHotelMediaData } = await import("./queries");
    const supabase = fakeSupabase([
      { id: "p1", category: "pool", title: "Bassin", photo_url: "https://x/1.jpg", alt_text: "Piscine", is_selected: true, position: 0 },
      { id: "p2", category: "pool", title: null, photo_url: "https://x/2.jpg", alt_text: null, is_selected: false, position: 1 },
      { id: "p3", category: "spa", title: null, photo_url: "https://x/3.jpg", alt_text: null, is_selected: true, position: 0 },
    ]);

    const data = await getHotelMediaData("hotel-a", supabase as never);

    const pool = data.categories.find((c) => c.category === "pool")!;
    expect(pool.photos.map((p) => p.id)).toEqual(["p1", "p2"]);
    const spa = data.categories.find((c) => c.category === "spa")!;
    expect(spa.photos.map((p) => p.id)).toEqual(["p3"]);
    const sauna = data.categories.find((c) => c.category === "sauna")!;
    expect(sauna.photos).toEqual([]);
  });

  it("[forme des photos] exposes id/category/title/url/alt/isSelected", async () => {
    const { getHotelMediaData } = await import("./queries");
    const supabase = fakeSupabase([{ id: "p1", category: "facade", title: "Entrée", photo_url: "https://x/1.jpg", alt_text: "Façade principale", is_selected: true, position: 0 }]);

    const data = await getHotelMediaData("hotel-a", supabase as never);

    const facade = data.categories.find((c) => c.category === "facade")!;
    expect(facade.photos).toEqual([{ id: "p1", category: "facade", title: "Entrée", url: "https://x/1.jpg", alt: "Façade principale", isSelected: true }]);
  });
});
