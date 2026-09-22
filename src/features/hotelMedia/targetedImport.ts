"use server";

import { revalidatePath } from "next/cache";
import { requireSuperadmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { safeFetchBinary } from "@/features/crawler/networkGuard";
import type { ActionResult } from "@/lib/actionResult";
import { LE_1837_HOTEL_ID, TARGETED_HOTEL_MEDIA_IMPORT_PLAN } from "./targetedImportPlan";

const CONTENT_TYPE_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
};

export interface ImportTargetedHotelMediaResult {
  photosImported: number;
  photosSkippedDuplicate: number;
  photosFailed: number;
}

/**
 * hotel_media equivalent of features/photos/targetedImport.ts::importTargetedRoomPhotos
 * — same shape, same discipline, no second implementation of the download/
 * validation logic: safeFetchBinary (features/crawler/networkGuard.ts) is
 * reused exactly as-is. ONE-OFF, hotel-scoped (LE_1837_HOTEL_ID only, same
 * guard), superadmin-only. Writes via the session-bound client (createClient(),
 * never createAdminClient()) so the "superadmin full access to hotel_media"
 * RLS policy (0046_hotel_media.sql) is the actual gate — mirrors
 * importTargetedRoomPhotos' own reasoning for room_photos exactly.
 *
 * Coexists with the manual hotel_media upload (HotelMediaManager /
 * CategoryUploadForm, features/hotelMedia/actions.ts) — this is a second,
 * bulk feed path for already-known, already-verified URLs; nothing about
 * the manual upload path changes, room_photos is never touched here.
 *
 * Idempotent by construction: content_hash is checked per hotel BEFORE any
 * Storage upload or DB insert (same pre-check pattern as
 * saveAccommodationTypes), so re-running this action skips every photo
 * already imported rather than recreating it.
 */
export async function importTargetedHotelMedia(hotelId: string): Promise<ActionResult<ImportTargetedHotelMediaResult>> {
  await requireSuperadmin();

  if (hotelId !== LE_1837_HOTEL_ID) {
    return { ok: false, error: "Ce point d'entrée est scopé à un seul établissement — aucune action effectuée." };
  }

  const supabase = await createClient();
  const result: ImportTargetedHotelMediaResult = { photosImported: 0, photosSkippedDuplicate: 0, photosFailed: 0 };

  for (const categoryPlan of TARGETED_HOTEL_MEDIA_IMPORT_PLAN) {
    const { count } = await supabase
      .from("hotel_media")
      .select("id", { count: "exact", head: true })
      .eq("hotel_id", hotelId)
      .eq("category", categoryPlan.category);
    let position = count ?? 0;

    for (const imageUrl of categoryPlan.imageUrls) {
      const fetched = await safeFetchBinary(imageUrl);
      if (!fetched.ok || !fetched.body || !fetched.contentHash || !fetched.contentType) {
        console.error("importTargetedHotelMedia: photo download rejected", { url: imageUrl, reason: fetched.errorReason });
        result.photosFailed++;
        continue;
      }

      const { data: existingPhoto } = await supabase
        .from("hotel_media")
        .select("id")
        .eq("hotel_id", hotelId)
        .eq("content_hash", fetched.contentHash)
        .maybeSingle();
      if (existingPhoto) {
        result.photosSkippedDuplicate++;
        continue;
      }

      const extension = CONTENT_TYPE_EXTENSION[fetched.contentType] ?? "jpg";
      const storagePath = `${hotelId}/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage
        .from("hotel-media")
        .upload(storagePath, fetched.body, { upsert: false, contentType: fetched.contentType });
      if (uploadError) {
        console.error("importTargetedHotelMedia: storage upload failed", { message: uploadError.message });
        result.photosFailed++;
        continue;
      }
      const { data: publicUrlData } = supabase.storage.from("hotel-media").getPublicUrl(storagePath);

      const { error: insertError } = await supabase.from("hotel_media").insert({
        hotel_id: hotelId,
        category: categoryPlan.category,
        title: categoryPlan.title,
        source_page_url: categoryPlan.sourceUrl,
        source_image_url: imageUrl,
        storage_path: storagePath,
        photo_url: publicUrlData.publicUrl,
        content_hash: fetched.contentHash,
        alt_text: null,
        position,
        is_selected: true,
      });
      if (insertError) {
        console.error("importTargetedHotelMedia: hotel_media insert failed", { message: insertError.message });
        result.photosFailed++;
        continue;
      }
      position++;
      result.photosImported++;
    }
  }

  revalidatePath(`/etablissements/${hotelId}/photos`);
  return { ok: true, data: result };
}
