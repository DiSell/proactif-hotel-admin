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
 * ONE-OFF, hotel-scoped import of the 47 photos identified via a real,
 * human-reviewed Playwright inspection of Le 1837's own official room
 * pages — never LLM-selected, never guessed. Every URL's filename carries
 * its own category's slug (e.g. "app-deluxe-1.jpg"), independently
 * cross-checked against accommodation_types.source_url before being
 * accepted by the action.
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
] as const;

/** Pure, derived from the plan above — never a separately hardcoded number that could drift from the real arrays. */
export function targetedImportSummary(): { name: string; count: number }[] {
  return TARGETED_PHOTO_IMPORT_PLAN.map((c) => ({ name: c.name, count: c.imageUrls.length }));
}

export function targetedImportTotal(): number {
  return TARGETED_PHOTO_IMPORT_PLAN.reduce((sum, c) => sum + c.imageUrls.length, 0);
}
