import { LE_1837_HOTEL_ID } from "@/features/photos/targetedImportPlan";
import type { HotelMediaCategory } from "@/types/database";

export { LE_1837_HOTEL_ID };

export interface TargetedHotelMediaCategoryPlan {
  category: HotelMediaCategory;
  title: string | null;
  sourceUrl: string;
  imageUrls: string[];
}

/**
 * hotel_media equivalent of features/photos/targetedImportPlan.ts — same
 * discipline: plain data, only URLs already fetched and verified to return
 * a real (non-placeholder) image, never guessed. Each sourceUrl below was
 * confirmed live (HTTP 200) and each imageUrl confirmed to resolve to a
 * real image, not notfound.jpg. Categories with no verified URL yet are
 * simply absent — never filled with a guess. HOTEL_MEDIA_CATEGORIES
 * (types/database.ts) is the only source of valid `category` values.
 */
export const TARGETED_HOTEL_MEDIA_IMPORT_PLAN: readonly TargetedHotelMediaCategoryPlan[] = [
  {
    category: "pool",
    title: null,
    sourceUrl: "https://www.le1837.com/en/pool",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-4.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-6.jpg",
    ],
  },
  {
    category: "spa",
    title: null,
    sourceUrl: "https://www.le1837.com/en/the-spa",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-21.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-59.jpg",
    ],
  },
  {
    category: "restaurant",
    title: null,
    sourceUrl: "https://www.le1837.com/en/restoration",
    imageUrls: ["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-20.jpg"],
  },
  {
    category: "seminar",
    title: null,
    sourceUrl: "https://www.le1837.com/en/seminar-groups",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-74.jpg",
      "https://www.le1837.com/imagecache/fullwidth/room-service_6.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_8.jpg",
    ],
  },
  {
    category: "wedding",
    title: null,
    sourceUrl: "https://www.le1837.com/en/weddings-receptions",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/salles_2.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_3.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_10.jpg",
      "https://www.le1837.com/imagecache/fullwidth/salles_13.jpg",
    ],
  },
  {
    // No dedicated route exists for this category (confirmed by extracting
    // the full route list from the compiled Vue router) — sourceUrl is the
    // site's homepage, the page these were actually observed on via a real
    // browser's Network tab (see this conversation's own report), not a
    // guessed category-specific page.
    category: "fitness",
    title: null,
    sourceUrl: "https://www.le1837.com/en",
    imageUrls: ["https://www.le1837.com/imagecache/fullwidth/residence-le-1837-64.jpg"],
  },
  {
    category: "facade",
    title: null,
    sourceUrl: "https://www.le1837.com/en",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-7.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-53.jpg",
    ],
  },
  {
    category: "common_area",
    title: null,
    sourceUrl: "https://www.le1837.com/en",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-12.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-14.jpg",
    ],
  },
  {
    category: "breakfast",
    title: null,
    sourceUrl: "https://www.le1837.com/en",
    imageUrls: [
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-71.jpg",
      "https://www.le1837.com/imagecache/fullwidth/residence-le-1837-72.jpg",
    ],
  },
] as const;

/** Pure, derived from the plan above — never a separately hardcoded number that could drift from the real arrays. */
export function targetedHotelMediaImportSummary(): { category: HotelMediaCategory; count: number }[] {
  return TARGETED_HOTEL_MEDIA_IMPORT_PLAN.map((c) => ({ category: c.category, count: c.imageUrls.length }));
}

export function targetedHotelMediaImportTotal(): number {
  return TARGETED_HOTEL_MEDIA_IMPORT_PLAN.reduce((sum, c) => sum + c.imageUrls.length, 0);
}
