"use client";

interface RoomPhotoModalProps {
  name: string;
  photos: { url: string; alt: string | null }[];
  pageUrl: string | null;
  bookingUrl: string | null;
  onClose: () => void;
}

/**
 * Shows the photos + links behind a "Voir la chambre" trigger in
 * ChatPreview. Never renders a link that isn't actually present — pageUrl/
 * bookingUrl both come straight from the server (accommodation_types.source_url
 * and hotels.booking_url respectively, see answer.ts / the chat route), never
 * guessed here.
 */
export function RoomPhotoModal({ name, photos, pageUrl, bookingUrl, onClose }: RoomPhotoModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-ink">{name}</h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="text-body/60 hover:text-ink">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {photos.length === 0 ? (
            <p className="text-xs italic text-body/60">Aucune photo disponible pour cet hébergement.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {photos.map((photo, index) => (
                // eslint-disable-next-line @next/next/no-img-element -- externally-hosted photo URLs from Supabase Storage, not a local/optimizable asset.
                <img
                  key={`${photo.url}-${index}`}
                  src={photo.url}
                  alt={photo.alt ?? name}
                  className="aspect-[4/3] w-full rounded-lg border border-border object-cover"
                />
              ))}
            </div>
          )}
        </div>

        {(pageUrl || bookingUrl) && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {pageUrl && (
              <a href={pageUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-body underline hover:text-ink">
                Voir la page
              </a>
            )}
            {bookingUrl && (
              <a
                href={bookingUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-canvas hover:opacity-90"
              >
                Réserver
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
