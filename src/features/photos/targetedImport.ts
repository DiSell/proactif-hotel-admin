"use server";

import { requireSuperadmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { saveAccommodationTypes, type SaveAccommodationTypesResult } from "@/features/knowledge/actions";
import type { SaveAccommodationTypesInput } from "@/features/knowledge/schema";
import type { ActionResult } from "@/lib/actionResult";
import { LE_1837_HOTEL_ID, TARGETED_PHOTO_IMPORT_PLAN } from "./targetedImportPlan";

/**
 * PHOTOS / CARROUSEL chantier — ONE-OFF, hotel-scoped import of the 47
 * photos identified via a real, human-reviewed Playwright inspection of
 * Le 1837's own official room pages (see this conversation's own report).
 * Deliberately scoped to exactly ONE hotel (LE_1837_HOTEL_ID) — this entry
 * point exists to unblock this one specific, already-diagnosed case (Le
 * 1837's site is a Vue SPA the crawler cannot render, so the normal
 * crawl-driven curation UI can never surface these images on its own).
 * Building a general "import photos for any hotel by URL" mechanism
 * without a second real need would be speculative complexity, not a
 * verified fix — the plan (targetedImportPlan.ts) is the single source of
 * truth for both this action and the UI/tests.
 *
 * Reuses saveAccommodationTypes (knowledge/actions.ts) AS-IS, unmodified:
 * same session-bound createClient(), same RLS "superadmin full access"
 * policy, same safeFetchBinary/Storage/content_hash/position/is_selected
 * behavior. This function's only job is to build the exact payload from
 * the plan and hand it to that existing, already-tested function — never a
 * second implementation of the import logic. No service_role client is
 * ever used here for the write.
 *
 * requireSuperadmin() is called here too, even though saveAccommodationTypes
 * already enforces it — defense in depth, matching this codebase's existing
 * convention (every exported action in knowledge/actions.ts does the same),
 * never relied upon as the ONLY gate.
 *
 * maxGuests is read fresh from accommodation_types right before building the
 * payload — NEVER hardcoded, NEVER invented — so saveAccommodationTypes'
 * unconditional `update({ max_guests: accommodation.maxGuests, ... })` can
 * never silently erase an existing value. sourceUrl is double-checked
 * against the plan's own expected value; a mismatch refuses that category
 * outright rather than importing against a possibly-renamed/moved page.
 */
export async function importTargetedRoomPhotos(hotelId: string): Promise<ActionResult<SaveAccommodationTypesResult>> {
  await requireSuperadmin();

  if (hotelId !== LE_1837_HOTEL_ID) {
    return { ok: false, error: "Ce point d'entrée est scopé à un seul établissement — aucune action effectuée." };
  }

  const supabase = await createClient();
  const { data: types, error } = await supabase
    .from("accommodation_types")
    .select("id,name,source_url,max_guests")
    .eq("hotel_id", hotelId)
    .in(
      "name",
      TARGETED_PHOTO_IMPORT_PLAN.map((c) => c.name)
    );
  if (error) {
    return { ok: false, error: "Impossible de relire les hébergements existants — aucune action effectuée." };
  }

  const byName = new Map((types ?? []).map((t) => [t.name, t]));
  const accommodationTypes: SaveAccommodationTypesInput["accommodationTypes"] = [];
  for (const category of TARGETED_PHOTO_IMPORT_PLAN) {
    const existing = byName.get(category.name);
    if (!existing) {
      return { ok: false, error: `"${category.name}" est introuvable pour cet hôtel — aucune action effectuée.` };
    }
    if (existing.source_url !== category.sourceUrl) {
      return {
        ok: false,
        error: `"${category.name}" : source_url en base ("${existing.source_url}") ne correspond plus à la page validée ("${category.sourceUrl}") — aucune action effectuée.`,
      };
    }
    accommodationTypes.push({
      name: category.name,
      sourceUrl: category.sourceUrl,
      // Read fresh above, never invented — preserves whatever is already on file (including null).
      maxGuests: existing.max_guests,
      photos: category.imageUrls.map((imageUrl) => ({
        imageUrl,
        altText: null,
        sourceUrl: category.sourceUrl,
        isSelected: true,
      })),
    });
  }

  return saveAccommodationTypes(hotelId, { accommodationTypes });
}
