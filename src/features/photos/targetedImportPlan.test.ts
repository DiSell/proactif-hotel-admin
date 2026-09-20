import { describe, expect, it } from "vitest";
import { TARGETED_PHOTO_IMPORT_PLAN, targetedImportSummary, targetedImportTotal } from "./targetedImportPlan";

/**
 * Real invocation — pure data + pure functions, no Supabase/network
 * involved. Confirms the plan itself matches exactly what was validated by
 * the real Playwright inspection this conversation performed, and that the
 * derived summary/total the UI displays can never drift from it.
 *
 * EXTENSION 47 -> 58: Superior and Deluxe PMR added afterward. Their
 * filenames do NOT follow the "app-{slug}-{n}" convention the first 5
 * categories share (Superior uses the French "superieur"; Deluxe PMR uses
 * opaque content-hash filenames) — their association instead came from each
 * page's own <title>/<h1> and the site's own sitemap.xml (see this
 * conversation's own audit report), so the filename-slug check below is
 * scoped to the 5 categories it actually applies to, never silently
 * loosened for all 7.
 */
describe("TARGETED_PHOTO_IMPORT_PLAN", () => {
  it("[exactly 7 categories, in the validated order]", () => {
    expect(TARGETED_PHOTO_IMPORT_PLAN.map((c) => c.name)).toEqual([
      "Mini-suite",
      "Standard",
      "Deluxe",
      "Junior Suite",
      "Junior PMR",
      "Superior",
      "Deluxe PMR",
    ]);
  });

  it("[exact per-category counts — 6/10/8/11/12/8/3]", () => {
    const counts = Object.fromEntries(TARGETED_PHOTO_IMPORT_PLAN.map((c) => [c.name, c.imageUrls.length]));
    expect(counts).toEqual({
      "Mini-suite": 6,
      Standard: 10,
      Deluxe: 8,
      "Junior Suite": 11,
      "Junior PMR": 12,
      Superior: 8,
      "Deluxe PMR": 3,
    });
  });

  it("[total is exactly 58]", () => {
    const total = TARGETED_PHOTO_IMPORT_PLAN.reduce((sum, c) => sum + c.imageUrls.length, 0);
    expect(total).toBe(58);
  });

  it("[no cross-category contamination, filename-slug convention] every URL's filename carries its own category's slug — never another category's — for the 5 categories that follow this convention", () => {
    const slugConventionCategories = ["Mini-suite", "Standard", "Deluxe", "Junior Suite", "Junior PMR"];
    for (const category of TARGETED_PHOTO_IMPORT_PLAN.filter((c) => slugConventionCategories.includes(c.name))) {
      const slug = category.name.toLowerCase().replace(/\s+/g, "-");
      for (const url of category.imageUrls) {
        expect(url.toLowerCase()).toContain(`app-${slug}-`);
      }
    }
  });

  it("[Superior — verified by page title/h1 + sitemap, not filename slug] its own filenames use the French spelling 'superieur', never the English 'superior'", () => {
    const superior = TARGETED_PHOTO_IMPORT_PLAN.find((c) => c.name === "Superior")!;
    for (const url of superior.imageUrls) {
      expect(url.toLowerCase()).toContain("app-superieur-");
      expect(url.toLowerCase()).not.toContain("app-superior-");
    }
  });

  it("[Deluxe PMR — verified by page title/h1 + sitemap, not filename slug] its filenames are opaque content hashes, never the 'app-{slug}-{n}' convention", () => {
    const deluxePmr = TARGETED_PHOTO_IMPORT_PLAN.find((c) => c.name === "Deluxe PMR")!;
    for (const url of deluxePmr.imageUrls) {
      expect(url).not.toMatch(/app-[a-z-]+-\d+\.jpg$/);
      expect(url).toMatch(/\/[0-9a-f]{32}\.jpg$/);
    }
  });

  it("[no duplicate URLs anywhere across all 58]", () => {
    const allUrls = TARGETED_PHOTO_IMPORT_PLAN.flatMap((c) => c.imageUrls);
    expect(allUrls.length).toBe(58);
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
      Superior: "https://www.le1837.com/en/superior",
      "Deluxe PMR": "https://www.le1837.com/en/deluxe-impr",
    });
  });

  it("[Deluxe PMR sourceUrl is never the stale 404 link] the plan never references https://www.le1837.com/en/deluxe-pmr — that link 404s on the live site (see this conversation's own audit report); the real page is /en/deluxe-impr", () => {
    const allSourceUrls = TARGETED_PHOTO_IMPORT_PLAN.map((c) => c.sourceUrl);
    expect(allSourceUrls).not.toContain("https://www.le1837.com/en/deluxe-pmr");
    const allImageUrls = TARGETED_PHOTO_IMPORT_PLAN.flatMap((c) => c.imageUrls);
    for (const url of allImageUrls) {
      expect(url).not.toContain("/en/deluxe-pmr");
    }
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

  it("[Superior order preserved] non-sequential DOM order (1,2,5,6,7,9,15,10) captured live, never re-sorted", () => {
    expect(TARGETED_PHOTO_IMPORT_PLAN.find((c) => c.name === "Superior")!.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-1.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-9.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-15.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-10.jpg",
    ]);
  });

  it("[Deluxe PMR order preserved] the 3 hashed filenames, in DOM order", () => {
    expect(TARGETED_PHOTO_IMPORT_PLAN.find((c) => c.name === "Deluxe PMR")!.imageUrls).toEqual([
      "https://www.le1837.com/imagecache/fullwidth/eba91a3f222d183eb1ab6c2c0ff5b1cf.jpg",
      "https://www.le1837.com/imagecache/fullwidth/cf6eeef4f9f74a15bb718fdd90fa2a98.jpg",
      "https://www.le1837.com/imagecache/fullwidth/2261ef964c7ecba68e28c9c4c59c1d35.jpg",
    ]);
  });

  it("[the original 47 are still exactly as they were] the first 5 categories' counts/URLs are completely untouched by this extension", () => {
    const original5 = TARGETED_PHOTO_IMPORT_PLAN.filter((c) => c.name !== "Superior" && c.name !== "Deluxe PMR");
    const originalTotal = original5.reduce((sum, c) => sum + c.imageUrls.length, 0);
    expect(originalTotal).toBe(47);
  });
});

describe("targetedImportSummary / targetedImportTotal — derived, never a separate hardcoded number", () => {
  it("[summary] mirrors the plan's own per-category counts exactly, including the 2 newly added categories", () => {
    expect(targetedImportSummary()).toEqual([
      { name: "Mini-suite", count: 6 },
      { name: "Standard", count: 10 },
      { name: "Deluxe", count: 8 },
      { name: "Junior Suite", count: 11 },
      { name: "Junior PMR", count: 12 },
      { name: "Superior", count: 8 },
      { name: "Deluxe PMR", count: 3 },
    ]);
  });

  it("[total] equals the sum of the summary's own counts — computed, never duplicated as a literal", () => {
    const total = targetedImportTotal();
    const summedFromSummary = targetedImportSummary().reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(summedFromSummary);
    expect(total).toBe(58);
  });
});
