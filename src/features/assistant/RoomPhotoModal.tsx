"use client";

import { useState } from "react";

interface RoomPhotoModalProps {
  name: string;
  photos: { url: string; alt: string | null }[];
  pageUrl: string | null;
  bookingUrl: string | null;
  onClose: () => void;
  /**
   * RACCORDER host_widget chantier — when provided, takes priority over
   * bookingUrl for the "Réserver" action: a real <button> calling this
   * callback instead of the plain <a href={bookingUrl}> link. Lets a
   * caller (PublicWidgetChat, for a hotel configured with
   * booking_action_mode="host_widget") trigger its own existing
   * host-booking mechanism (requestHostBooking/postMessage) without this
   * component ever knowing what "host_widget" means — it only ever sees an
   * opaque callback, exactly like onClose. ChatPreview never passes this
   * (no host page to trigger anything on), so bookingUrl keeps working
   * there exactly as before. Never both a callback button AND a bookingUrl
   * link at once — see the render logic below.
   */
  onBooking?: () => void;
  /** Disables the Réserver button and marks it aria-busy while a triggered onBooking request is still in flight — prevents a second concurrent click, never affects the bookingUrl link path. */
  bookingPending?: boolean;
  /**
   * A caller-supplied, ready-to-display message (e.g.
   * PublicWidgetChat's own HOST_BOOKING_UNAVAILABLE_MESSAGE) shown next to
   * Réserver when a triggered onBooking request failed. This component
   * never hardcodes or imports that string itself — it stays agnostic to
   * whatever mechanism onBooking represents, same principle as onBooking
   * itself. null/undefined renders nothing.
   */
  bookingErrorMessage?: string | null;
}

/**
 * Shows the photos + links behind a "Voir la chambre" trigger in
 * ChatPreview. Never renders a link that isn't actually present — pageUrl/
 * bookingUrl both come straight from the server (accommodation_types.source_url
 * and hotels.booking_url respectively, see answer.ts / the chat route), never
 * guessed here.
 *
 * PHOTOS / CARROUSEL chantier: main photo + a scrollable strip of clickable
 * thumbnails below it, ordered by room_photos.position (the array order this
 * component receives is never re-sorted here — the server is the single
 * source of truth for order, see buildRoomRecommendation in answer.ts).
 * selectedIndex resets to 0 whenever `photos` itself changes identity (a
 * fresh key on the outer element below achieves this without a useEffect —
 * the component simply remounts for a different accommodation/photo set,
 * exactly like switching to a different modal). 0 or 1 photo needs no
 * thumbnail strip at all — that's not a real carousel, just noise.
 */
export function RoomPhotoModal({ name, photos, pageUrl, bookingUrl, onClose, onBooking, bookingPending, bookingErrorMessage }: RoomPhotoModalProps) {
  return (
    <RoomPhotoModalInner
      key={photos.map((p) => p.url).join("|")}
      name={name}
      photos={photos}
      pageUrl={pageUrl}
      bookingUrl={bookingUrl}
      onClose={onClose}
      onBooking={onBooking}
      bookingPending={bookingPending}
      bookingErrorMessage={bookingErrorMessage}
    />
  );
}

function RoomPhotoModalInner({ name, photos, pageUrl, bookingUrl, onClose, onBooking, bookingPending, bookingErrorMessage }: RoomPhotoModalProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedPhoto = photos[selectedIndex] ?? null;

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
          {!selectedPhoto ? (
            <p className="text-xs italic text-body/60">Aucune photo disponible pour cet hébergement.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element -- externally-hosted photo URLs from Supabase Storage, not a local/optimizable asset. */}
              <img
                src={selectedPhoto.url}
                alt={selectedPhoto.alt ?? name}
                className="aspect-[4/3] w-full rounded-lg border border-border object-cover"
              />

              {photos.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={`Photos de ${name}`}>
                  {photos.map((photo, index) => {
                    const isActive = index === selectedIndex;
                    return (
                      <button
                        key={`${photo.url}-${index}`}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        aria-label={`Photo ${index + 1} sur ${photos.length}`}
                        onClick={() => setSelectedIndex(index)}
                        className={`h-14 w-14 flex-shrink-0 overflow-hidden rounded-md border-2 transition-opacity ${
                          isActive ? "border-ink" : "border-transparent opacity-70 hover:opacity-100"
                        }`}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- externally-hosted photo URLs from Supabase Storage, not a local/optimizable asset. */}
                        <img src={photo.url} alt={photo.alt ?? `${name} — miniature ${index + 1}`} className="h-full w-full object-cover" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {(pageUrl || bookingUrl || onBooking) && (
          <div className="border-t border-border px-5 py-3">
            <div className="flex items-center justify-end gap-2">
              {pageUrl && (
                <a href={pageUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-body underline hover:text-ink">
                  Voir la page
                </a>
              )}
              {/* onBooking always wins over bookingUrl — never both a callback button and a link at once, see this component's own doc comment. */}
              {onBooking ? (
                <button
                  type="button"
                  onClick={onBooking}
                  disabled={bookingPending}
                  aria-busy={bookingPending}
                  className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-canvas hover:opacity-90 disabled:cursor-default disabled:opacity-60"
                >
                  Réserver
                </button>
              ) : (
                bookingUrl && (
                  <a
                    href={bookingUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-full bg-ink px-4 py-2 text-xs font-medium text-canvas hover:opacity-90"
                  >
                    Réserver
                  </a>
                )
              )}
            </div>
            {bookingErrorMessage && <p className="mt-2 text-right text-2xs text-danger">{bookingErrorMessage}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
