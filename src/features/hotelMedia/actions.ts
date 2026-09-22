"use server";

import { revalidatePath } from "next/cache";
import { requireHotelAccess } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";
import type { Hotel } from "@/types/database";
import { addHotelMediaSchema } from "./schema";

/**
 * Upload itself (File -> Supabase Storage) happens client-side in
 * HotelMediaManager.tsx, mirroring features/hotels/wizard/StepInfo.tsx's
 * own logo upload — no precedent in this codebase for a Server Action
 * accepting a raw File, and the existing precedent (StepInfo.tsx) already
 * solves this the same way: browser uploads directly, this action only
 * ever receives the resulting Storage path/URL plus metadata.
 *
 * Shared between back-office (always allowed) and client portal (allowed
 * only when hotels.photo_management = 'client' — see the two exported
 * wrappers below). requireHotelAccess(hotelId, scope) both authorizes the
 * caller for this exact hotelId AND returns the correctly cookie-scoped
 * session-bound client, reused below instead of constructing a second one —
 * same shape as setHotelMediaSelectionInternal.
 */
async function addHotelMediaPhotoInternal(hotelId: string, input: unknown, scope: AuthScope): Promise<ActionResult<{ id: string }>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  // hotels.photo_management only ever gates hotel_media for the CLIENT
  // portal — a superadmin (the only caller requireHotelAccess ever accepts
  // on the "backoffice" scope in practice, see AppShell's requireSuperadmin()
  // gate on every back-office page) can always add photos regardless of
  // this hotel's mode. Read via the session-bound client returned above —
  // "hotel_admin can read own hotel" (0011_hotel_client_portal.sql) already
  // permits this under RLS, no admin client needed for a plain read.
  if (scope === "client") {
    const { data: hotel } = await supabase
      .from("hotels")
      .select("photo_management")
      .eq("id", hotelId)
      .maybeSingle<Pick<Hotel, "photo_management">>();
    if (hotel?.photo_management !== "client") {
      return { ok: false, error: "L’ajout de photos est réservé à Proactif System pour cet hôtel." };
    }
  }

  const parsed = addHotelMediaSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Photo invalide." };
  }

  // Backoffice: the session-bound superadmin client itself, gated by the
  // "superadmin full access to hotel_media" RLS policy (0046) — unchanged
  // from before this refactor. Client: service_role (0047 grants it INSERT
  // only), reachable here ONLY after the photo_management check above
  // already authorized this exact write — RLS on hotel_media grants
  // hotel_admin SELECT only, never INSERT (0046/0047), by design.
  const writer = scope === "client" ? createAdminClient() : supabase;

  const { count } = await writer
    .from("hotel_media")
    .select("id", { count: "exact", head: true })
    .eq("hotel_id", hotelId)
    .eq("category", parsed.data.category);

  const { data: inserted, error } = await writer
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
    console.error("addHotelMediaPhoto: insert failed", { hotelId, scope, message: error?.message });
    return { ok: false, error: "Impossible d’enregistrer cette photo." };
  }

  revalidatePath("/client/photos");
  revalidatePath(`/etablissements/${hotelId}/photos`);
  return { ok: true, data: { id: inserted.id } };
}

export async function addHotelMediaPhotoBackoffice(hotelId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  return addHotelMediaPhotoInternal(hotelId, input, "backoffice");
}

export async function addHotelMediaPhotoClient(hotelId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  return addHotelMediaPhotoInternal(hotelId, input, "client");
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
