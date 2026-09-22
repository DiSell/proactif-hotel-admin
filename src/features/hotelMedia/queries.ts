import type { SupabaseClient } from "@supabase/supabase-js";
import { HOTEL_MEDIA_CATEGORIES, type HotelMedia, type HotelMediaCategory } from "@/types/database";

export interface HotelMediaPhoto {
  id: string;
  category: HotelMediaCategory;
  title: string | null;
  url: string;
  alt: string | null;
  isSelected: boolean;
}

export interface HotelMediaData {
  hotelId: string;
  /** Every category, in the fixed order of HOTEL_MEDIA_CATEGORIES, each with whatever photos exist (possibly none) — never limited to categories that already have a photo, so the admin sees the full picture of what's still empty. */
  categories: { category: HotelMediaCategory; photos: HotelMediaPhoto[] }[];
}

/**
 * Session-bound read — same discipline as features/photos/queries.ts's own
 * getPhotosManagerData: RLS is the real gate (see 0046_hotel_media.sql's
 * "hotel_admin can read own hotel_media" / "superadmin full access"
 * policies), the explicit `.eq("hotel_id", hotelId)` below is defense in
 * depth, not a substitute. `supabase` is REQUIRED, no default — back-office
 * and client portal use different session cookies and this shared function
 * has no way to know which one its caller authenticated under.
 */
export async function getHotelMediaData(hotelId: string, supabase: SupabaseClient): Promise<HotelMediaData> {
  const { data: photos } = await supabase
    .from("hotel_media")
    .select("id, category, title, photo_url, alt_text, is_selected, position")
    .eq("hotel_id", hotelId)
    .order("position", { ascending: true })
    .returns<Pick<HotelMedia, "id" | "category" | "title" | "photo_url" | "alt_text" | "is_selected" | "position">[]>();

  const photosByCategory = new Map<HotelMediaCategory, HotelMediaPhoto[]>();
  for (const photo of photos ?? []) {
    const list = photosByCategory.get(photo.category) ?? [];
    list.push({ id: photo.id, category: photo.category, title: photo.title, url: photo.photo_url, alt: photo.alt_text, isSelected: photo.is_selected });
    photosByCategory.set(photo.category, list);
  }

  return {
    hotelId,
    categories: HOTEL_MEDIA_CATEGORIES.map((category) => ({ category, photos: photosByCategory.get(category) ?? [] })),
  };
}
