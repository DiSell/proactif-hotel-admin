import type { SupabaseClient } from "@supabase/supabase-js";

export interface RoomPhoto {
  url: string;
  alt: string | null;
}

/**
 * CATÉGORIES INFORMATION CLIQUABLES chantier — extracted verbatim from
 * answer.ts's own buildRoomRecommendation (PHOTOS / CARROUSEL chantier),
 * never a rewrite: same table, same columns, same three filters, same
 * order. Reused by two callers now: buildRoomRecommendation (unchanged
 * behavior — this is a pure extraction) and the new
 * /api/widget/[widgetKey]/room-photos route (on-demand fetch triggered by a
 * click on an accommodationSummary entry, never eagerly loaded).
 *
 * is_selected is the client's (or, when hotels.photo_management ===
 * 'proactif', the superadmin's) own curation flag — see room_photos.is_selected's
 * own migration comment and features/photos/actions.ts. A deselected photo
 * must never reach the public widget just because a caller forgot the
 * filter — this is the single place that filter is applied, for every
 * caller.
 */
export async function loadSelectedRoomPhotos(supabase: SupabaseClient, hotelId: string, accommodationTypeId: string): Promise<RoomPhoto[]> {
  const { data: photos } = await supabase
    .from("room_photos")
    .select("photo_url, alt_text")
    .eq("hotel_id", hotelId)
    .eq("accommodation_type_id", accommodationTypeId)
    .eq("is_selected", true)
    .order("position", { ascending: true });

  return (photos ?? []).map((p) => ({ url: p.photo_url as string, alt: p.alt_text as string | null }));
}
