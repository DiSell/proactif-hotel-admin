import { describe, expect, it } from "vitest";
import { TARGETED_PHOTO_IMPORT_PLAN, targetedImportSummary, targetedImportTotal } from "./targetedImportPlan";

/**
 * Real invocation — pure data + pure functions, no Supabase/network
 * involved. Confirms the plan itself matches exactly what was validated by
 * the real Playwright inspection this conversation performed, and that the
 * derived summary/total the UI displays can never drift from it.
 */
describe("TARGETED_PHOTO_IMPORT_PLAN", () => {
  it("[exactly 5 categories, in the validated order]", () => {
    expect(TARGETED_PHOTO_IMPORT_PLAN.map((c) => c.name)).toEqual(["Mini-suite", "Standard", "Deluxe", "Junior Suite", "Junior PMR"]);
  });

  it("[exact per-category counts — 6/10/8/11/12]", () => {
    const counts = Object.fromEntries(TARGETED_PHOTO_IMPORT_PLAN.map((c) => [c.name, c.imageUrls.length]));
    expect(counts).toEqual({
      "Mini-suite": 6,
      Standard: 10,
      Deluxe: 8,
      "Junior Suite": 11,
      "Junior PMR": 12,
    });
  });

  it("[total is exactly 47]", () => {
    const total = TARGETED_PHOTO_IMPORT_PLAN.reduce((sum, c) => sum + c.imageUrls.length, 0);
    expect(total).toBe(47);
  });

  it("[no cross-category contamination] every URL's filename carries its own category's slug — never another category's", () => {
    for (const category of TARGETED_PHOTO_IMPORT_PLAN) {
      const slug = category.name.toLowerCase().replace(/\s+/g, "-");
      for (const url of category.imageUrls) {
        expect(url.toLowerCase()).toContain(`app-${slug}-`);
      }
    }
  });

  it("[no duplicate URLs within a category, and none across categories either]", () => {
    const allUrls = TARGETED_PHOTO_IMPORT_PLAN.flatMap((c) => c.imageUrls);
    expect(new Set(allUrls).size).toBe(allUrls.length);
  });

  it("[sourceUrl matches the exact official page for each category]", () => {
    const bySourceUrl = Object.fromEntries(TARGETED_PHOTO_IMPORT_PLAN.map((c) => [c.name, c.sourceUrl]));
    expect(bySourceUrl).toEqual({
      "Mini-suite": "https://www.le1837.com/en/mini-suite",
      Standard: "https://www.le1837.com/en/standard",
      Deluxe: "https://www.le1837.com/en/deluxe",
      "Junior Suite": "https://www.le1837.com/en/junior-suite",
      "Junior PMR": "https://www.le1837.com/en/junior-pmr",
    });
  });

  it("[order preserved] each category's imageUrls array is read as-is, in the exact DOM order captured live — never sorted alphabetically/numerically here", () => {
    // The Deluxe filenames are deliberately non-sequential (8,7,6,5,4,3,2,1) — a real signal
    // that the site's own curated display order does not match ascending filename numbers
    // (see this conversation's own report). A silent re-sort would destroy that real order.
    expect(TARGETED_PHOTO_IMPORT_PLAN.find((c) => c.name === "Deluxe")!.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-8.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-3.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-1.jpg",
    ]);
  });
});

describe("targetedImportSummary / targetedImportTotal — derived, never a separate hardcoded number", () => {
  it("[summary] mirrors the plan's own per-category counts exactly", () => {
    expect(targetedImportSummary()).toEqual([
      { name: "Mini-suite", count: 6 },
      { name: "Standard", count: 10 },
      { name: "Deluxe", count: 8 },
      { name: "Junior Suite", count: 11 },
      { name: "Junior PMR", count: 12 },
    ]);
  });

  it("[total] equals the sum of the summary's own counts — computed, never duplicated as a literal", () => {
    const total = targetedImportTotal();
    const summedFromSummary = targetedImportSummary().reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(summedFromSummary);
    expect(total).toBe(47);
  });
});
