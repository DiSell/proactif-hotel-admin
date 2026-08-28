"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import type { PhotoManagerAccommodation } from "./queries";
import type { PhotoActions } from "./actionBundles";

interface PhotosManagerProps {
  hotelId: string;
  accommodations: PhotoManagerAccommodation[];
  /**
   * The whole bundle of scope-bound Server Actions to use — NEVER a
   * `scope` string. The page passes PHOTO_ACTIONS_BACKOFFICE or
   * PHOTO_ACTIONS_CLIENT (features/photos/actionBundles.ts); this
   * component never decides or transmits which cookie scope is used, it
   * only ever invokes whichever function reference it was given — see
   * features/photos/actions.ts's own doc comment for why.
   */
  actions: PhotoActions;
}

/**
 * Shared between /client/photos (hotel_admin) and
 * /etablissements/[id]/photos (superadmin, "select on behalf of the
 * client" when photo_management = 'proactif') — identical UI and
 * behavior for both. Every distinct photo detected for an accommodation is
 * shown here — never capped — with an explicit "Tout sélectionner"/"Tout
 * désélectionner" pair plus individual per-photo toggling.
 */
export function PhotosManager({ hotelId, accommodations, actions }: PhotosManagerProps) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [pendingPhotoId, setPendingPhotoId] = useState<string | null>(null);

  function togglePhoto(photoId: string, next: boolean) {
    setPendingPhotoId(photoId);
    startTransition(async () => {
      const result = await actions.setPhotoSelection(hotelId, photoId, next);
      setPendingPhotoId(null);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.refresh();
    });
  }

  function selectAll(accommodationTypeId: string, next: boolean) {
    startTransition(async () => {
      const result = await actions.setAccommodationPhotosSelection(hotelId, accommodationTypeId, next);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.refresh();
    });
  }

  if (accommodations.length === 0) {
    return (
      <EmptyState
        title="Aucun hébergement détecté pour le moment."
        description="Les hébergements et leurs photos apparaîtront ici après l’analyse du site (voir Connaissances)."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {accommodations.map((accommodation) => {
        const selectedCount = accommodation.photos.filter((photo) => photo.isSelected).length;
        const allSelected = accommodation.photos.length > 0 && selectedCount === accommodation.photos.length;
        const noneSelected = selectedCount === 0;
        return (
          <Card key={accommodation.id} className="flex flex-col gap-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-ink">{accommodation.name}</h3>
                <p className="text-2xs text-body/60">
                  {selectedCount}/{accommodation.photos.length} photo(s) affichée(s) dans le chatbot
                </p>
              </div>
              {accommodation.photos.length > 0 && (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => selectAll(accommodation.id, true)}
                    disabled={isPending || allSelected}
                    className="rounded-md border border-border px-2.5 py-1.5 text-2xs font-medium text-ink hover:bg-canvas disabled:opacity-40"
                  >
                    Tout sélectionner
                  </button>
                  <button
                    type="button"
                    onClick={() => selectAll(accommodation.id, false)}
                    disabled={isPending || noneSelected}
                    className="rounded-md border border-border px-2.5 py-1.5 text-2xs font-medium text-ink hover:bg-canvas disabled:opacity-40"
                  >
                    Tout désélectionner
                  </button>
                </div>
              )}
            </div>

            {accommodation.photos.length === 0 ? (
              <p className="text-2xs text-body/50">Aucune photo détectée pour cet hébergement.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {accommodation.photos.map((photo) => (
                  <label key={photo.id} className="relative cursor-pointer" title={photo.alt ?? undefined}>
                    <input
                      type="checkbox"
                      checked={photo.isSelected}
                      disabled={isPending && pendingPhotoId === photo.id}
                      onChange={() => togglePhoto(photo.id, !photo.isSelected)}
                      className="sr-only"
                      aria-label={`Afficher la photo ${photo.alt ?? ""} dans le chatbot`}
                    />
                    {/* eslint-disable-next-line @next/next/no-img-element -- already-imported photo, served from Supabase Storage's own public URL */}
                    <img
                      src={photo.url}
                      alt={photo.alt ?? ""}
                      className={`h-20 w-28 rounded object-cover ${photo.isSelected ? "ring-2 ring-ink" : "opacity-50 hover:opacity-80"}`}
                    />
                    {photo.isSelected && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-canvas">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      </span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
