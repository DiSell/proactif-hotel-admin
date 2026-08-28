import type { SupabaseClient } from "@supabase/supabase-js";
import type { AccommodationType, Hotel, RoomPhoto } from "@/types/database";

export interface PhotoManagerPhoto {
  id: string;
  url: string;
  alt: string | null;
  isSelected: boolean;
}

export interface PhotoManagerAccommodation {
  id: string;
  name: string;
  photos: PhotoManagerPhoto[];
}

export interface PhotoManagerData {
  hotelId: string;
  photoManagement: Hotel["photo_management"];
  accommodations: PhotoManagerAccommodation[];
}

/**
 * Session-bound read (RLS is the real gate — see
 * supabase/migrations/0014_chatbot_personalization.sql's hotel_admin SELECT
 * policies on accommodation_types/room_photos, alongside the existing
 * "superadmin full access" policy on both from 0004_accommodation_types.sql).
 *
 * Deliberately performs NO authorization itself — callers must have already
 * resolved and authorized hotelId (requireClientAccess() for the client
 * portal, requireSuperadmin()+getHotel(id) for the back-office) before
 * calling this, same as every other query in features/client/queries.ts.
 * The explicit `.eq("hotel_id", hotelId)` filters below are defense in
 * depth on top of RLS, not a substitute for it.
 *
 * `supabase` is REQUIRED — no default, no fallback — because back-office
 * and the client portal use different session cookies
 * (lib/supabase/cookieScope.ts), and this shared function has no way to
 * know on its own which one its caller actually authenticated under.
 * /etablissements/[id]/photos/page.tsx passes createClient() (back-office);
 * src/app/client/photos/page.tsx passes createClientPortalClient().
 */
export async function getPhotosManagerData(hotelId: string, supabase: SupabaseClient): Promise<PhotoManagerData> {

  const [{ data: hotel }, { data: accommodationTypes }, { data: photos }] = await Promise.all([
    supabase.from("hotels").select("photo_management").eq("id", hotelId).maybeSingle<Pick<Hotel, "photo_management">>(),
    supabase
      .from("accommodation_types")
      .select("id, name")
      .eq("hotel_id", hotelId)
      .order("created_at", { ascending: true })
      .returns<Pick<AccommodationType, "id" | "name">[]>(),
    supabase
      .from("room_photos")
      .select("id, accommodation_type_id, photo_url, alt_text, is_selected, position")
      .eq("hotel_id", hotelId)
      .order("position", { ascending: true })
      .returns<Pick<RoomPhoto, "id" | "accommodation_type_id" | "photo_url" | "alt_text" | "is_selected" | "position">[]>(),
  ]);

  const photosByAccommodation = new Map<string, PhotoManagerPhoto[]>();
  for (const photo of photos ?? []) {
    const list = photosByAccommodation.get(photo.accommodation_type_id) ?? [];
    list.push({ id: photo.id, url: photo.photo_url, alt: photo.alt_text, isSelected: photo.is_selected });
    photosByAccommodation.set(photo.accommodation_type_id, list);
  }

  return {
    hotelId,
    photoManagement: hotel?.photo_management ?? "client",
    accommodations: (accommodationTypes ?? []).map((accommodation) => ({
      id: accommodation.id,
      name: accommodation.name,
      photos: photosByAccommodation.get(accommodation.id) ?? [],
    })),
  };
}
