"use server";

import { revalidatePath } from "next/cache";
import { requireHotelAccess, requireSuperadmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";
import { addHotelMediaSchema } from "./schema";

/**
 * Upload itself (File -> Supabase Storage) happens client-side in
 * HotelMediaManager.tsx, mirroring features/hotels/wizard/StepInfo.tsx's
 * own logo upload — no precedent in this codebase for a Server Action
 * accepting a raw File, and the existing precedent (StepInfo.tsx) already
 * solves this the same way: browser uploads directly, this action only
 * ever receives the resulting Storage path/URL plus metadata.
 *
 * Superadmin-only, matching EVERY existing photo-import path in this
 * codebase without exception (saveAccommodationTypes / targetedImport,
 * both requireSuperadmin()) — there is no precedent anywhere for a
 * hotel_admin-writable Storage bucket, and 0046_hotel_media.sql's
 * "superadmin manage hotel-media" Storage policy enforces the same
 * restriction at the Storage layer, not just here. hotelId is a plain
 * argument (not resolved from a session) because this is a back-office-only
 * action — same shape as saveAccommodationTypes(hotelId, input).
 *
 * Uses the session-bound client (createClient(), not createAdminClient())
 * so the "superadmin full access" RLS policy on hotel_media is the actual
 * gate — same discipline as saveAccommodationTypes itself.
 */
export async function addHotelMediaPhoto(hotelId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireSuperadmin();

  const parsed = addHotelMediaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Photo invalide." };
  }

  const supabase = await createClient();

  const { count } = await supabase
    .from("hotel_media")
    .select("id", { count: "exact", head: true })
    .eq("hotel_id", hotelId)
    .eq("category", parsed.data.category);

  const { data: inserted, error } = await supabase
    .from("hotel_media")
    .insert({
      hotel_id: hotelId,
      category: parsed.data.category,
      title: parsed.data.title,
      storage_path: parsed.data.storagePath,
      photo_url: parsed.data.photoUrl,
      content_hash: parsed.data.contentHash,
      alt_text: parsed.data.altText,
      position: count ?? 0,
    })
    .select("id")
    .single();

  if (error || !inserted) {
    // 23505 = hotel_media_hotel_content_hash_key — this exact file was
    // already imported for this hotel (any category). Not treated as a
    // technical error: the Storage object uploaded just before this call is
    // orphaned in that case (never referenced by any row) but never
    // duplicated in hotel_media itself — same acceptable trade-off already
    // present in saveAccommodationTypes' own content_hash dedup.
    if (error?.code === "23505") {
      return { ok: false, error: "Cette photo a déjà été importée pour cet hôtel." };
    }
    console.error("addHotelMediaPhoto: insert failed", { hotelId, message: error?.message });
    return { ok: false, error: "Impossible d’enregistrer cette photo." };
  }

  revalidatePath("/client/photos");
  revalidatePath(`/etablissements/${hotelId}/photos`);
  return { ok: true, data: { id: inserted.id } };
}

/**
 * Same authorization/write discipline as
 * features/photos/actions.ts::setPhotoSelectionInternal, exactly — shared
 * between back-office (superadmin) and client portal (hotel_admin) via
 * requireHotelAccess(hotelId, scope); the actual write goes through
 * service_role (RLS only allows superadmin directly, see
 * 0046_hotel_media.sql), authorization is enforced by the prior check, not
 * by RLS on this path.
 */
async function setHotelMediaSelectionInternal(hotelId: string, photoId: string, isSelected: boolean, scope: AuthScope): Promise<ActionResult<null>> {
  await requireHotelAccess(hotelId, scope);

  const supabase = createAdminClient();
  const { error } = await supabase.from("hotel_media").update({ is_selected: isSelected }).eq("id", photoId).eq("hotel_id", hotelId);
  if (error) {
    console.error("setHotelMediaSelection: hotel_media update failed", { message: error.message });
    return { ok: false, error: "Impossible de mettre à jour cette photo." };
  }

  revalidatePath("/client/photos");
  revalidatePath(`/etablissements/${hotelId}/photos`);
  return { ok: true, data: null };
}

export async function setHotelMediaSelectionBackoffice(hotelId: string, photoId: string, isSelected: boolean): Promise<ActionResult<null>> {
  return setHotelMediaSelectionInternal(hotelId, photoId, isSelected, "backoffice");
}

export async function setHotelMediaSelectionClient(hotelId: string, photoId: string, isSelected: boolean): Promise<ActionResult<null>> {
  return setHotelMediaSelectionInternal(hotelId, photoId, isSelected, "client");
}
