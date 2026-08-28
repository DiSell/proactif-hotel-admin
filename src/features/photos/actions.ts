"use server";

import { revalidatePath } from "next/cache";
import { requireHotelAccess } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";

/**
 * Guarded by requireHotelAccess(hotelId, scope) — the SAME check the chat
 * routes and the partner actions already use — which authorizes EITHER a
 * superadmin (any hotel, scope "backoffice") OR the hotel_admin linked to
 * this exact hotel (scope "client"). This is what implements "si le client
 * délègue la gestion à Proactif System, le superadmin peut faire la
 * sélection à sa place" for free: no separate superadmin-only action or
 * mode check needed, the same underlying logic already works for both
 * roles, each restricted to their own authorized hotel.
 *
 * `scope` is NEVER a parameter on any exported Server Action below — same
 * discipline as features/partners/actions.ts (see that file's own doc
 * comment for the full reasoning): a client component (PhotosManager.tsx)
 * must never be able to supply or influence which cookie scope a shared
 * action reads. Each `*Internal` function takes `scope` as a plain
 * argument but is never itself exported/"use server"-callable; every
 * actually-exported action is a thin wrapper with the scope HARDCODED at
 * the export itself. PhotosManager.tsx receives the whole bundle of either
 * the *Backoffice or the *Client actions as a prop from whichever page
 * rendered it, and simply invokes whichever function reference it was
 * given.
 *
 * Writes via the service_role client after authorization — RLS is not the
 * gate on this path, the prior check is (same discipline as
 * features/hotelUsers/actions.ts). The explicit `.eq("hotel_id", hotelId)`
 * on top of `.eq("id", photoId)` is defense in depth: even a guessed
 * photoId belonging to another hotel can never be updated through this
 * action, whichever role calls it.
 */
async function setPhotoSelectionInternal(
  hotelId: string,
  photoId: string,
  isSelected: boolean,
  scope: AuthScope
): Promise<ActionResult<null>> {
  await requireHotelAccess(hotelId, scope);

  const supabase = createAdminClient();
  const { error } = await supabase.from("room_photos").update({ is_selected: isSelected }).eq("id", photoId).eq("hotel_id", hotelId);
  if (error) {
    console.error("setPhotoSelection: room_photos update failed", { message: error.message });
    return { ok: false, error: "Impossible de mettre à jour cette photo." };
  }

  revalidatePath("/client/photos");
  revalidatePath(`/etablissements/${hotelId}/photos`);
  return { ok: true, data: null };
}

export async function setPhotoSelectionBackoffice(hotelId: string, photoId: string, isSelected: boolean): Promise<ActionResult<null>> {
  return setPhotoSelectionInternal(hotelId, photoId, isSelected, "backoffice");
}

export async function setPhotoSelectionClient(hotelId: string, photoId: string, isSelected: boolean): Promise<ActionResult<null>> {
  return setPhotoSelectionInternal(hotelId, photoId, isSelected, "client");
}

/** The "Tout sélectionner" / "Tout désélectionner" action for one accommodation's full photo set — same authorization as setPhotoSelection above. */
async function setAccommodationPhotosSelectionInternal(
  hotelId: string,
  accommodationTypeId: string,
  isSelected: boolean,
  scope: AuthScope
): Promise<ActionResult<null>> {
  await requireHotelAccess(hotelId, scope);

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("room_photos")
    .update({ is_selected: isSelected })
    .eq("hotel_id", hotelId)
    .eq("accommodation_type_id", accommodationTypeId);
  if (error) {
    console.error("setAccommodationPhotosSelection: room_photos update failed", { message: error.message });
    return { ok: false, error: "Impossible de mettre à jour ces photos." };
  }

  revalidatePath("/client/photos");
  revalidatePath(`/etablissements/${hotelId}/photos`);
  return { ok: true, data: null };
}

export async function setAccommodationPhotosSelectionBackoffice(
  hotelId: string,
  accommodationTypeId: string,
  isSelected: boolean
): Promise<ActionResult<null>> {
  return setAccommodationPhotosSelectionInternal(hotelId, accommodationTypeId, isSelected, "backoffice");
}

export async function setAccommodationPhotosSelectionClient(
  hotelId: string,
  accommodationTypeId: string,
  isSelected: boolean
): Promise<ActionResult<null>> {
  return setAccommodationPhotosSelectionInternal(hotelId, accommodationTypeId, isSelected, "client");
}
