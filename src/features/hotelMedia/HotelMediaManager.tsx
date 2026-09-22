"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient, createClientPortalBrowserClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/Card";
import { FileDrop } from "@/components/ui/FileDrop";
import { useToast } from "@/components/ui/Toast";
import { HOTEL_MEDIA_CATEGORY_LABEL } from "./schema";
import type { HotelMediaActions } from "./actionBundles";
import type { HotelMediaData } from "./queries";
import type { HotelMediaCategory } from "@/types/database";
import type { AuthScope } from "@/lib/supabase/cookieScope";

interface HotelMediaManagerProps {
  hotelId: string;
  data: HotelMediaData;
  actions: HotelMediaActions;
  /** Back-office: upload always available. Client portal: only when hotels.photo_management === "client" — computed by the page from data already fetched via getPhotosManagerData, never re-derived here. */
  canUpload: boolean;
  /**
   * Which cookie-scoped browser Supabase client the upload form must use —
   * see resolveHotelMediaBrowserClient below. A plain string prop (not a
   * client-factory function prop) because this component is instantiated
   * from a Server Component page: a function bound to browser-only APIs
   * cannot cross that boundary as a prop. Never inferred from the current
   * URL/environment inside this component — always explicit, from the
   * caller, exactly like every other scope in this codebase.
   */
  scope: AuthScope;
}

/**
 * The one place this module decides which cookie a Storage upload/browser
 * write is bound to — pure, three-line, directly unit-testable, so nothing
 * else in this file has to "guess" its environment. Mirrors
 * requireHotelAccess's own scope -> client mapping (lib/auth/session.ts),
 * just for the browser-side clients (lib/supabase/client.ts) instead of the
 * server-side ones.
 */
export function resolveHotelMediaBrowserClient(scope: AuthScope) {
  return scope === "client" ? createClientPortalBrowserClient() : createClient();
}

/** SHA-256 of the file's own bytes, hex-encoded — client-side equivalent of safeFetchBinary's contentHash (features/crawler/networkGuard.ts), computed here instead of server-side since this flow uploads a browser File directly rather than fetching a remote URL. */
async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extensionFor(file: File): string {
  const fromName = file.name.split(".").pop();
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  return file.type.split("/")[1] || "jpg";
}

function CategoryUploadForm({
  hotelId,
  category,
  scope,
  addPhoto,
  onDone,
}: {
  hotelId: string;
  category: HotelMediaCategory;
  scope: AuthScope;
  addPhoto: HotelMediaActions["addPhoto"];
  onDone: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [altText, setAltText] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  async function handleFileSelected(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.show("Le fichier sélectionné n’est pas une image.", "danger");
      return;
    }
    setPreviewUrl(URL.createObjectURL(file));
    setIsUploading(true);
    try {
      const contentHash = await hashFile(file);
      const supabase = resolveHotelMediaBrowserClient(scope);
      const storagePath = `${hotelId}/${crypto.randomUUID()}.${extensionFor(file)}`;
      const { error: uploadError } = await supabase.storage.from("hotel-media").upload(storagePath, file, { upsert: false, contentType: file.type });
      if (uploadError) {
        toast.show("Échec de l’envoi du fichier.", "danger");
        return;
      }
      const { data: publicUrlData } = supabase.storage.from("hotel-media").getPublicUrl(storagePath);

      const result = await addPhoto(hotelId, {
        category,
        title,
        altText,
        storagePath,
        photoUrl: publicUrlData.publicUrl,
        contentHash,
      });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Photo ajoutée.");
      setTitle("");
      setAltText("");
      setPreviewUrl(null);
      onDone();
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Titre (facultatif)"
          className="h-9 rounded-lg border border-border px-3 text-xs"
        />
        <input
          value={altText}
          onChange={(event) => setAltText(event.target.value)}
          placeholder="Texte alternatif (facultatif)"
          className="h-9 rounded-lg border border-border px-3 text-xs"
        />
      </div>
      <FileDrop onFileSelected={handleFileSelected} previewUrl={previewUrl} hint={isUploading ? "Envoi en cours…" : undefined} />
    </div>
  );
}

export function HotelMediaManager({ hotelId, data, actions, canUpload, scope }: HotelMediaManagerProps) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [pendingPhotoId, setPendingPhotoId] = useState<string | null>(null);

  function togglePhoto(photoId: string, next: boolean) {
    setPendingPhotoId(photoId);
    startTransition(async () => {
      const result = await actions.setSelection(hotelId, photoId, next);
      setPendingPhotoId(null);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-ink">Photos de l’établissement</h3>
        <p className="mt-1 text-2xs text-body/60">Piscine, spa, façade, espaces communs… — indépendant des photos d’hébergement ci-dessus.</p>
      </div>
      {data.categories.map(({ category, photos }) => (
        <Card key={category} className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold text-ink">{HOTEL_MEDIA_CATEGORY_LABEL[category]}</h4>
            <p className="text-2xs text-body/60">{photos.length} photo(s)</p>
          </div>

          {photos.length === 0 ? (
            <p className="text-2xs text-body/50">Aucune photo pour cette catégorie.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {photos.map((photo) => (
                <label key={photo.id} className="relative cursor-pointer" title={photo.title ?? photo.alt ?? undefined}>
                  <input
                    type="checkbox"
                    checked={photo.isSelected}
                    disabled={isPending && pendingPhotoId === photo.id}
                    onChange={() => togglePhoto(photo.id, !photo.isSelected)}
                    className="sr-only"
                    aria-label={`Afficher la photo ${photo.title ?? photo.alt ?? ""}`}
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

          {canUpload && (
            <CategoryUploadForm
              hotelId={hotelId}
              category={category}
              scope={scope}
              addPhoto={actions.addPhoto}
              onDone={() => router.refresh()}
            />
          )}
        </Card>
      ))}
    </div>
  );
}
