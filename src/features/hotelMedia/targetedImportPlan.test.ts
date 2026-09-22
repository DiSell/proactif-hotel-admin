import { describe, expect, it } from "vitest";
import { HOTEL_MEDIA_CATEGORIES } from "@/types/database";
import { TARGETED_HOTEL_MEDIA_IMPORT_PLAN, targetedHotelMediaImportSummary, targetedHotelMediaImportTotal } from "./targetedImportPlan";

/**
 * Real invocation — pure data + pure functions, no Supabase/network
 * involved. Mirrors features/photos/targetedImportPlan.test.ts exactly in
 * spirit: pins down what was actually verified live (curl, this
 * conversation's own report) rather than re-deriving it, and guards
 * against silent drift between the plan and the summary/total the UI
 * displays.
 */
describe("TARGETED_HOTEL_MEDIA_IMPORT_PLAN", () => {
  it("[every category is a real hotel_media category] never a value outside HOTEL_MEDIA_CATEGORIES", () => {
    for (const entry of TARGETED_HOTEL_MEDIA_IMPORT_PLAN) {
      expect(HOTEL_MEDIA_CATEGORIES).toContain(entry.category);
    }
  });

  it("[currently exactly 5 categories, verified live so far — pool, spa, restaurant, seminar, wedding]", () => {
    expect(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.map((c) => c.category)).toEqual(["pool", "spa", "restaurant", "seminar", "wedding"]);
  });

  it("[exactly 1 image per category currently] no invented/guessed extra URLs", () => {
    for (const entry of TARGETED_HOTEL_MEDIA_IMPORT_PLAN) {
      expect(entry.imageUrls.length).toBe(1);
    }
  });

  it("[total is exactly 5]", () => {
    const total = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.reduce((sum, c) => sum + c.imageUrls.length, 0);
    expect(total).toBe(5);
  });

  it("[no duplicate URLs within this plan]", () => {
    const allUrls = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.flatMap((c) => c.imageUrls);
    expect(new Set(allUrls).size).toBe(allUrls.length);
  });

  it("[sourceUrl matches the exact official page verified live for each category]", () => {
    const bySourceUrl = Object.fromEntries(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.map((c) => [c.category, c.sourceUrl]));
    expect(bySourceUrl).toEqual({
      pool: "https://www.le1837.com/en/pool",
      spa: "https://www.le1837.com/en/the-spa",
      restaurant: "https://www.le1837.com/en/restoration",
      seminar: "https://www.le1837.com/en/seminar-groups",
      wedding: "https://www.le1837.com/en/weddings-receptions",
    });
  });

  it("[image URLs, verified] the exact fullwidth URL confirmed live per category (HTTP 200, real image, not notfound.jpg)", () => {
    const byCategory = Object.fromEntries(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.map((c) => [c.category, c.imageUrls]));
    expect(byCategory).toEqual({
      pool: ["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-4.jpg"],
      spa: ["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-21.jpg"],
      restaurant: ["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-20.jpg"],
      seminar: ["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-74.jpg"],
      wedding: ["https://www.le1837.com/imagecache/fullwidth/salles_2.jpg"],
    });
  });

  it("[no notfound.jpg / placeholder ever in the plan]", () => {
    const allUrls = TARGETED_HOTEL_MEDIA_IMPORT_PLAN.flatMap((c) => c.imageUrls);
    for (const url of allUrls) {
      expect(url).not.toContain("notfound");
    }
  });

  it("[no overlap with the 58 already-imported accommodation photo URLs]", () => {
    const hotelMediaUrls = new Set(TARGETED_HOTEL_MEDIA_IMPORT_PLAN.flatMap((c) => c.imageUrls));
    // The specific known collisions checked during this audit: an accommodation
    // photo (Deluxe PMR) and a room_photos-only image incidentally seen on the
    // presentation page — neither belongs in this plan.
    expect(hotelMediaUrls.has("https://www.le1837.com/imagecache/fullwidth/eba91a3f222d183eb1ab6c2c0ff5b1cf.jpg")).toBe(false);
    expect(hotelMediaUrls.has("https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-13.jpg")).toBe(false);
  });
});

describe("targetedHotelMediaImportSummary / targetedHotelMediaImportTotal — derived, never a separate hardcoded number", () => {
  it("[summary] mirrors the plan's own per-category counts exactly", () => {
    expect(targetedHotelMediaImportSummary()).toEqual([
      { category: "pool", count: 1 },
      { category: "spa", count: 1 },
      { category: "restaurant", count: 1 },
      { category: "seminar", count: 1 },
      { category: "wedding", count: 1 },
    ]);
  });

  it("[total] equals the sum of the summary's own counts — computed, never duplicated as a literal", () => {
    const total = targetedHotelMediaImportTotal();
    const summedFromSummary = targetedHotelMediaImportSummary().reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(summedFromSummary);
    expect(total).toBe(5);
  });
});
