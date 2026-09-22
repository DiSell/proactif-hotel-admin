import { describe, expect, it } from "vitest";
import { HOTEL_MEDIA_CATEGORIES } from "@/types/database";
import { TARGETED_HOTEL_MEDIA_IMPORT_PLAN, targetedHotelMediaImportSummary, targetedHotelMediaImportTotal } from "./targetedImportPlan";

/**
 * Real invocation — pure data + pure functions, no Supabase/network
 * involved. Mirrors features/photos/targetedImportPlan.test.ts exactly in
 * spirit: pins down what was actually verified live (curl HTTP 200 checks
 * + visual inspection of the downloaded images, this conversation's own
 * report — URLs supplied by the user from their browser's own Network tab)
 * rather than re-deriving it, and guards against silent drift between the
 * plan and the summary/total the UI displays.
 */
describe("TARGETED_HOTEL_MEDIA_IMPORT_PLAN", () => {
  it("[every category is a real hotel_media category] never a value outside HOTEL_MEDIA_CATEGORIES", () => {
    for (const entry of TARGETED_HOTEL_MEDIA_IMPORT_PLAN) {
      expect(HOTEL_MEDIA_CATEGORIES).toContain(entry.category);
    }
  });

  it("[currently exactly 9 categories, verified live]", () => {
    expect(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.map((c) => c.category)).toEqual([
      "pool",
      "spa",
      "restaurant",
      "seminar",
      "wedding",
      "fitness",
      "facade",
      "common_area",
      "breakfast",
    ]);
  });

  it("[per-category image counts — 2/2/1/3/4/1/2/2/2]", () => {
    const counts = Object.fromEntries(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.map((c) => [c.category, c.imageUrls.length]));
    expect(counts).toEqual({
      pool: 2,
      spa: 2,
      restaurant: 1,
      seminar: 3,
      wedding: 4,
      fitness: 1,
      facade: 2,
      common_area: 2,
      breakfast: 2,
    });
  });

  it("[total is exactly 19]", () => {
    const total = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.reduce((sum, c) => sum + c.imageUrls.length, 0);
    expect(total).toBe(19);
  });

  it("[no duplicate URLs within this plan]", () => {
    const allUrls = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.flatMap((c) => c.imageUrls);
    expect(new Set(allUrls).size).toBe(allUrls.length);
  });

  it("[no notfound.jpg / placeholder ever in the plan]", () => {
    const allUrls = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.flatMap((c) => c.imageUrls);
    for (const url of allUrls) {
      expect(url).not.toContain("notfound");
    }
  });

  it("[no overlap with the 58 already-imported accommodation photo URLs — every app-* filename spotted in the raw Chrome list was excluded]", () => {
    const hotelMediaUrls = new Set(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.flatMap((c) => c.imageUrls));
    for (const url of hotelMediaUrls) {
      expect(url).not.toMatch(/app-(deluxe|junior-pmr|junior-suite|mini-suite|standard|superieur)-/);
    }
    // Specific known collisions checked during this audit.
    expect(hotelMediaUrls.has("https://www.le1837.com/imagecache/fullwidth/eba91a3f222d183eb1ab6c2c0ff5b1cf.jpg")).toBe(false);
    expect(hotelMediaUrls.has("https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-13.jpg")).toBe(false);
  });

  it("[no tourism-only content — lac-de-pareloup/saint-rome-tarn/la-cavalerie excluded, they represent the region, not the establishment]", () => {
    const hotelMediaUrls = new Set(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.flatMap((c) => c.imageUrls));
    for (const url of hotelMediaUrls) {
      expect(url).not.toMatch(/lac-de-pareloup|saint-rome-tarn|la-cavalerie/);
    }
  });

  it("[pool — 2 images, both verified live]", () => {
    const pool = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "pool")!;
    expect(pool.sourceUrl).toBe("https://www.le1837.com/en/pool");
    expect(pool.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-6.jpg",
    ]);
  });

  it("[spa — 2 images]", () => {
    const spa = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "spa")!;
    expect(spa.sourceUrl).toBe("https://www.le1837.com/en/the-spa");
    expect(spa.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-21.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-59.jpg",
    ]);
  });

  it("[restaurant — unchanged, 1 image]", () => {
    const restaurant = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "restaurant")!;
    expect(restaurant.imageUrls).toEqual(["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-20.jpg"]);
  });

  it("[seminar — 3 images, including the explicit \"Bienvenue & Bonne conférence\" catering photo]", () => {
    const seminar = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "seminar")!;
    expect(seminar.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-74.jpg",
      "https://www.le1837.com/imagecache/fullwidth/room-service_6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_8.jpg",
    ]);
  });

  it("[wedding — 4 images, including the explicit \"JUST MARRIED\" photo]", () => {
    const wedding = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "wedding")!;
    expect(wedding.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/salles_2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_3.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_10.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_13.jpg",
    ]);
  });

  it("[fitness — new category, 1 image, gym equipment confirmed by visual inspection]", () => {
    const fitness = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "fitness")!;
    expect(fitness.imageUrls).toEqual(["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-64.jpg"]);
  });

  it("[facade — new category, 2 images (day + night exterior)]", () => {
    const facade = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "facade")!;
    expect(facade.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-53.jpg",
    ]);
  });

  it("[common_area — new category, 2 images (reception desk + lobby staircase)]", () => {
    const commonArea = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "common_area")!;
    expect(commonArea.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-12.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-14.jpg",
    ]);
  });

  it("[breakfast — new category, 2 images (in-room breakfast tray + fruit bowl)]", () => {
    const breakfast = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.find((c) => c.category === "breakfast")!;
    expect(breakfast.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-71.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-72.jpg",
    ]);
  });
});

describe("targetedHotelMediaImportSummary / targetedHotelMediaImportTotal — derived, never a separate hardcoded number", () => {
  it("[summary] mirrors the plan's own per-category counts exactly", () => {
    expect(targetedHotelMediaImportSummary()).toEqual([
      { category: "pool", count: 2 },
      { category: "spa", count: 2 },
      { category: "restaurant", count: 1 },
      { category: "seminar", count: 3 },
      { category: "wedding", count: 4 },
      { category: "fitness", count: 1 },
      { category: "facade", count: 2 },
      { category: "common_area", count: 2 },
      { category: "breakfast", count: 2 },
    ]);
  });

  it("[total] equals the sum of the summary's own counts — computed, never duplicated as a literal", () => {
    const total = targetedHotelMediaImportTotal();
    const summedFromSummary = targetedHotelMediaImportSummary().reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(summedFromSummary);
    expect(total).toBe(19);
  });
});
