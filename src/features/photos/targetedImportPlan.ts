/**
 * PHOTOS / CARROUSEL chantier — plain data + pure helpers, deliberately kept
 * OUT of targetedImport.ts: a "use server" module may only export async
 * functions (Next.js Server Actions constraint) — this file holds the
 * constant plan and its pure derived helpers so a Server Component (the
 * page) and a plain test file can both import them as values, and
 * targetedImport.ts (the actual "use server" action) imports the plan from
 * here rather than duplicating it.
 *
 * See targetedImport.ts's own doc comment for the full rationale: a
 * ONE-OFF, hotel-scoped import of the photos identified via a real,
 * human-reviewed Playwright inspection of Le 1837's own official room
 * pages — never LLM-selected, never guessed. Built up in two passes: the
 * first 5 categories (47 photos) whose filenames carry their own category's
 * slug (e.g. "app-deluxe-1.jpg"); Superior and Deluxe PMR (11 more photos,
 * 58 total) added afterward once their own official pages were separately
 * found and verified (see each category's own inline comment below for how)
 * — every entry cross-checked against accommodation_types.source_url before
 * being accepted by the action, whether or not the filename itself carries
 * a matching slug.
 */
export const LE_1837_HOTEL_ID = "a675cb48-8deb-4c59-86af-9e6d11ed0a6d";

export interface TargetedCategoryPlan {
  name: string;
  sourceUrl: string;
  /** Exact order captured from the live DOM render of the official page — see this conversation's own Playwright inspection report. */
  imageUrls: string[];
}

/**
 * The exact 47 URLs, grouped by category, in the exact order captured live.
 * Single source of truth for the action, the UI summary, and the tests —
 * never duplicated as separate literals anywhere else, so displayed counts,
 * the payload actually sent to saveAccommodationTypes, and the tests can
 * never silently drift apart.
 */
export const TARGETED_PHOTO_IMPORT_PLAN: readonly TargetedCategoryPlan[] = [
  {
    name: "Mini-suite",
    sourceUrl: "https://www.le1837.com/en/mini-suite",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-mini-suite-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-mini-suite-6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-mini-suite-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-mini-suite-8.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-mini-suite-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-mini-suite-1.jpg",
    ],
  },
  {
    name: "Standard",
    sourceUrl: "https://www.le1837.com/en/standard",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-1.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-3.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-8.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-11.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-12.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-standard-13.jpg",
    ],
  },
  {
    name: "Deluxe",
    sourceUrl: "https://www.le1837.com/en/deluxe",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-8.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-3.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-deluxe-1.jpg",
    ],
  },
  {
    name: "Junior Suite",
    sourceUrl: "https://www.le1837.com/en/junior-suite",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-10.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-9.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-8.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-3.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-1.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-12.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-suite-11.jpg",
    ],
  },
  {
    name: "Junior PMR",
    sourceUrl: "https://www.le1837.com/en/junior-pmr",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-12.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-1.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-3.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-9.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-8.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-11.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-10.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-junior-pmr-13.jpg",
    ],
  },
  {
    // accommodation_types.source_url was null for this category before this
    // extension (never associated with an official page by any prior
    // chantier) — the file names use the French spelling "superieur", not
    // "superior"; the association to this category comes from the page's
    // own <title>/<h1> ("Superior") and its real link on the site's own
    // listing page (/en/apartment-2-pers), not from a filename slug match —
    // see this conversation's own audit report.
    name: "Superior",
    sourceUrl: "https://www.le1837.com/en/superior",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-1.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-5.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-9.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-15.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-app-superieur-10.jpg",
    ],
  },
  {
    // accommodation_types.source_url was null for this category before this
    // extension. IMPORTANT: the link found on the site's own listing page
    // (/en/apartment-2-pers -> "deluxe-pmr") 404s — it is a stale link the
    // site itself never updated. The real, live URL ("deluxe-impr") was
    // found only via the site's own sitemap.xml, confirmed by <h1>Deluxe
    // PMR</h1> on the loaded page — never guessed. Deliberately NOT
    // "https://www.le1837.com/en/deluxe-pmr" (404) — see this conversation's
    // own audit report. File names here are opaque content hashes, not the
    // "app-{slug}-{n}" convention used elsewhere on this site.
    name: "Deluxe PMR",
    sourceUrl: "https://www.le1837.com/en/deluxe-impr",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/eba91a3f222d183eb1ab6c2c0ff5b1cf.jpg",
      "https://www.le1837.com/imagecache/fullwidth/cf6eeef4f9f74a15bb718fdd90fa2a98.jpg",
      "https://www.le1837.com/imagecache/fullwidth/2261ef964c7ecba68e28c9c4c59c1d35.jpg",
    ],
  },
] as const;

/** Pure, derived from the plan above — never a separately hardcoded number that could drift from the real arrays. */
export function targetedImportSummary(): { name: string; count: number }[] {
  return TARGETED_PHOTO_IMPORT_PLAN.map((c) => ({ name: c.name, count: c.imageUrls.length }));
}

export function targetedImportTotal(): number {
  return TARGETED_PHOTO_IMPORT_PLAN.reduce((sum, c) => sum + c.imageUrls.length, 0);
}
