"use client";

import { useRef, useState } from "react";
import { RoomPhotoModal } from "./RoomPhotoModal";
import { AssistantMessageContent } from "@/components/ui/AssistantMessageContent";
import type { ActionResult } from "@/lib/actionResult";

type AnswerStatus = "answered" | "fallback" | "error" | "handoff";

interface MessageSource {
  sourceId: string;
  sourceTitle: string;
  similarity: number;
}

interface RoomRecommendation {
  accommodationTypeId: string;
  name: string;
  photos: { url: string; alt: string | null }[];
  pageUrl: string | null;
  bookingUrl: string | null;
}

type PartnerAction = { type: "partner_booking"; label: string; url: string } | { type: "partner_website"; label: string; url: string };

/** Mirrors features/rag/types.ts's PartnerRecommendation — see that type's own doc comment. */
interface PartnerRecommendation {
  id: string;
  name: string;
  category: string;
  description: string | null;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  websiteUrl: string | null;
  bookingUrl: string | null;
  action: PartnerAction | null;
}

/**
 * Generic CTA, independent of RoomRecommendation — see
 * features/rag/types.ts (ChatAction) for the server-side contract. `url` is
 * always hotels.booking_url, attached server-side; never null when this
 * object is present at all (see answer.ts's buildBookingAction — it
 * returns the whole action as null rather than an action with a null url).
 */
interface ChatAction {
  type: "booking";
  label: string;
  url: string;
}

/**
 * INFORMATION DÉTERMINISTE chantier — mirrors features/rag/types.ts's
 * RoomCatalogueEntry field-for-field (id/name/pageUrl/maxGuests, no price),
 * reused here ONLY for AnswerQuestionResult.accommodationSummary. Named
 * independently of "RoomCatalogueEntry" deliberately: ChatPreview does not
 * support the CATALOGUE parcours at all (out of scope for this chantier —
 * see this file's own history), so a name evoking a catalogue would be
 * misleading here.
 */
interface AccommodationSummaryEntry {
  accommodationTypeId: string;
  name: string;
  pageUrl: string | null;
  maxGuests: number | null;
}

interface ChatMessage {
  role: "assistant" | "user";
  content: string;
  answerStatus?: AnswerStatus;
  sources?: MessageSource[];
  roomRecommendation?: RoomRecommendation | null;
  action?: ChatAction | null;
  partnerRecommendations?: PartnerRecommendation[];
  accommodationSummary?: AccommodationSummaryEntry[];
}

interface ChatApiResponse {
  conversationId: string;
  reply: string;
  sources: MessageSource[];
  answerStatus: AnswerStatus;
  roomRecommendation: RoomRecommendation | null;
  action: ChatAction | null;
  partnerRecommendations: PartnerRecommendation[];
  accommodationSummary: AccommodationSummaryEntry[];
}

interface ChatPreviewProps {
  hotelId: string;
  assistantName: string;
  welcomeMessage: string;
  fullScreen?: boolean;
  /**
   * Defaults to true — preserves the admin dashboard's existing behavior
   * exactly. The client portal's "Tester mon chatbot" (features/client)
   * passes false: similarity scores and source titles stay an admin-only
   * debug affordance, not part of what a hotel's own client sees.
   */
  showSources?: boolean;
  /**
   * Defaults to /api/hotels/${hotelId}/chat (the back-office route,
   * requireHotelAccess(hotelId, "backoffice")) — preserves the admin
   * dashboard's existing behavior exactly. The client portal's "Tester mon
   * chatbot" (ChatbotPersonalizationForm.tsx) passes
   * /api/client/hotels/${hotelId}/chat instead (requireHotelAccess(hotelId,
   * "client")) — a dedicated route, not the same one with an inferred
   * scope, so this component never has to know which space it's rendered
   * in itself.
   */
  apiPath?: string;
  /**
   * PARITÉ PHOTOS ChatPreview chantier — the caller's own correctly-scoped
   * Server Action (getSelectedRoomPhotosBackoffice or
   * getSelectedRoomPhotosClient, features/photos/actions.ts), invoked
   * directly as a function call (no fetch, no widgetKey — this component
   * stays agnostic to which scope it's rendered under, exactly like apiPath
   * above: the PARENT decides which scope's action to hand down). Never
   * chosen by ChatPreview itself.
   */
  getRoomPhotosAction: (hotelId: string, accommodationTypeId: string) => Promise<ActionResult<RoomRecommendation>>;
}

export function ChatPreview({ hotelId, assistantName, welcomeMessage, fullScreen, showSources = true, apiPath, getRoomPhotosAction }: ChatPreviewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: welcomeMessage }]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRoomRecommendation, setOpenRoomRecommendation] = useState<RoomRecommendation | null>(null);

  // PARITÉ PHOTOS chantier — session-local only, a plain ref (mutating it
  // must never itself trigger a re-render; previewData below is what
  // actually drives what's shown). Never localStorage, never shared across
  // components/tabs. Shared by the click flow and the preview flow via the
  // single loadAccommodationPhotos below, so a category already loaded by
  // either one resolves instantly with zero further Server Action call for
  // the other.
  const accommodationPhotosCacheRef = useRef<Map<string, RoomRecommendation>>(new Map());
  // Independent from accommodationPreviewRequestRef below — a click and a
  // hover/focus preview for the SAME category must never let one's
  // resolution order affect the other's own guard.
  const accommodationSummaryRequestRef = useRef(0);
  const [loadingAccommodationTypeId, setLoadingAccommodationTypeId] = useState<string | null>(null);
  // Real per-visitor pointer capability, computed once (lazy initializer):
  // a floating preview only makes sense where a genuine hover gesture
  // exists. Deliberately NOT inferred from "did onMouseEnter fire" — some
  // touch browsers synthesize mouse events on tap, which would otherwise
  // show a preview an instant before the tap's own click opens the modal.
  const [supportsHoverDevice] = useState<boolean>(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches
  );
  // Which accommodationSummary entry's preview is currently shown (hover OR
  // keyboard focus) — never both a preview and a stale one from another row
  // at once.
  const [previewAccommodationTypeId, setPreviewAccommodationTypeId] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<RoomRecommendation | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const accommodationPreviewRequestRef = useRef(0);

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setInput("");
    setError(null);
    setMessages((current) => [...current, { role: "user", content: trimmed }]);
    setLoading(true);

    try {
      const response = await fetch(apiPath ?? `/api/hotels/${hotelId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: trimmed }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Une erreur est survenue.");
      }

      const data: ChatApiResponse = await response.json();
      setConversationId(data.conversationId);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: data.reply,
          answerStatus: data.answerStatus,
          sources: data.sources,
          roomRecommendation: data.roomRecommendation,
          action: data.action,
          partnerRecommendations: data.partnerRecommendations,
          accommodationSummary: data.accommodationSummary,
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue.");
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setMessages([{ role: "assistant", content: welcomeMessage }]);
    setConversationId(null);
    setError(null);
  }

  /**
   * PARITÉ PHOTOS chantier — cache-first (see accommodationPhotosCacheRef
   * above), otherwise invokes the caller-supplied Server Action (never a
   * fetch — no widgetKey, no new route: getRoomPhotosAction is already
   * scoped to this exact authenticated hotelId by the parent). Shared by
   * both the click flow (handleAccommodationSummaryClick) and the
   * hover/focus preview flow (handleAccommodationPreviewStart) below, so
   * the two can never duplicate a request for the same category. Throws on
   * a failed ActionResult (either a thrown redirect from requireHotelAccess
   * never reaching this catch, or an explicit `{ ok: false }`) — callers
   * decide what "failure" means for their own UI.
   */
  async function loadAccommodationPhotos(accommodationTypeId: string): Promise<RoomRecommendation> {
    const cached = accommodationPhotosCacheRef.current.get(accommodationTypeId);
    if (cached) return cached;

    const result = await getRoomPhotosAction(hotelId, accommodationTypeId);
    if (!result.ok || !result.data) {
      throw new Error(result.error || "getRoomPhotosAction failed");
    }
    accommodationPhotosCacheRef.current.set(accommodationTypeId, result.data);
    return result.data;
  }

  /**
   * Race-condition guard: accommodationSummaryRequestRef is incremented at
   * the very start of every call, before the loading state or the Server
   * Action call — a stale/superseded click's eventual result (success or
   * failure) is silently discarded, never reopens/overwrites the modal or
   * clears a newer click's own loading indicator.
   */
  async function handleAccommodationSummaryClick(entry: AccommodationSummaryEntry) {
    const requestId = accommodationSummaryRequestRef.current + 1;
    accommodationSummaryRequestRef.current = requestId;
    setLoadingAccommodationTypeId(entry.accommodationTypeId);
    try {
      const data = await loadAccommodationPhotos(entry.accommodationTypeId);
      if (accommodationSummaryRequestRef.current !== requestId) return; // superseded by a later click — discard silently
      setOpenRoomRecommendation(data);
    } catch {
      if (accommodationSummaryRequestRef.current !== requestId) return;
      setError("Impossible de charger les photos de cet hébergement. Réessayez.");
    } finally {
      if (accommodationSummaryRequestRef.current === requestId) setLoadingAccommodationTypeId(null);
    }
  }

  /**
   * Desktop hover / keyboard focus preview. Cache-first: an already-loaded
   * category displays instantly with zero Server Action call. Otherwise
   * shows a loading state (previewData === null, distinct from an empty
   * array) while loadAccommodationPhotos resolves. Own race-condition
   * token, independent of accommodationSummaryRequestRef — a slow preview
   * fetch for a category the pointer/focus has already left can never
   * overwrite a newer preview, and can never open a modal.
   */
  function handleAccommodationPreviewStart(entry: AccommodationSummaryEntry) {
    const requestId = accommodationPreviewRequestRef.current + 1;
    accommodationPreviewRequestRef.current = requestId;
    setPreviewAccommodationTypeId(entry.accommodationTypeId);
    setPreviewError(false);

    const cached = accommodationPhotosCacheRef.current.get(entry.accommodationTypeId);
    if (cached) {
      setPreviewData(cached);
      return;
    }
    setPreviewData(null); // still loading
    loadAccommodationPhotos(entry.accommodationTypeId)
      .then((data) => {
        if (accommodationPreviewRequestRef.current !== requestId) return;
        setPreviewData(data);
      })
      .catch(() => {
        if (accommodationPreviewRequestRef.current !== requestId) return;
        setPreviewError(true);
      });
  }

  /** mouseleave/blur — closes the preview and invalidates its in-flight fetch, but only if it's still the row currently showing. */
  function handleAccommodationPreviewEnd(accommodationTypeId: string) {
    accommodationPreviewRequestRef.current += 1;
    setPreviewAccommodationTypeId((current) => (current === accommodationTypeId ? null : current));
    setPreviewData(null);
    setPreviewError(false);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-3 bg-ink px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-canvas">
          {assistantName.slice(0, 1).toUpperCase() || "A"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-canvas">{assistantName || "Assistant"}</p>
          <p className="text-2xs text-canvas/55">Mode test — réponses réelles</p>
        </div>
        <button type="button" onClick={handleReset} className="text-2xs font-medium text-canvas/70 hover:text-canvas">
          Nouvelle conversation
        </button>
      </div>

      <div className={`flex flex-1 flex-col gap-3 overflow-y-auto p-4 ${fullScreen ? "" : "min-h-[320px]"}`}>
        {messages.map((message, index) => (
          <div key={index} className={`flex flex-col gap-1.5 ${message.role === "user" ? "items-end" : "items-start"}`}>
            <div
              className={`max-w-[78%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                message.role === "user" ? "bg-ink text-canvas" : "border border-border bg-surface"
              }`}
              style={{
                borderRadius: message.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
              }}
            >
              {message.role === "assistant" ? <AssistantMessageContent content={message.content} /> : message.content}
            </div>
            {showSources && message.role === "assistant" && message.answerStatus && (
              <SourcesDebugPanel answerStatus={message.answerStatus} sources={message.sources ?? []} />
            )}
            {message.role === "assistant" && message.roomRecommendation && (
              <button
                type="button"
                onClick={() => setOpenRoomRecommendation(message.roomRecommendation ?? null)}
                className="max-w-[78%] rounded-lg border border-border bg-canvas px-3 py-2 text-left text-2xs font-medium text-ink hover:border-ink"
              >
                Voir la chambre — {message.roomRecommendation.name}
              </button>
            )}
            {/* Server guarantees roomRecommendation and action are never both present for the same turn (see answer.ts's buildBookingAction) — no dedup needed here. */}
            {message.role === "assistant" && message.action && (
              <a
                href={message.action.url}
                target="_blank"
                rel="noreferrer"
                className="max-w-[78%] rounded-full bg-ink px-4 py-2 text-center text-2xs font-medium text-canvas hover:opacity-90"
              >
                {message.action.label}
              </a>
            )}
            {/*
             * PARITÉ PHOTOS ChatPreview chantier — mirrors PublicWidgetChat.tsx's
             * own accommodationSummary interactivity (real buttons, chevron,
             * hover/focus preview, click -> RoomPhotoModal), adapted to this
             * component's Tailwind styling and its authenticated
             * getRoomPhotosAction (never a fetch/widgetKey). Still no
             * border/background per row — never styled like a catalogue
             * card. roomCatalogue itself stays unsupported in this
             * component, unchanged, out of scope.
             */}
            {message.role === "assistant" && message.accommodationSummary && message.accommodationSummary.length > 0 && (
              <div className="flex max-w-[78%] flex-col gap-1 text-2xs">
                {message.accommodationSummary.map((entry) => {
                  const isPreviewing = previewAccommodationTypeId === entry.accommodationTypeId;
                  const isLoading = loadingAccommodationTypeId === entry.accommodationTypeId;
                  return (
                    <div key={entry.accommodationTypeId} className="relative">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-canvas focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-60"
                        onClick={() => handleAccommodationSummaryClick(entry)}
                        onMouseEnter={() => {
                          if (supportsHoverDevice) handleAccommodationPreviewStart(entry);
                        }}
                        onMouseLeave={() => {
                          if (supportsHoverDevice) handleAccommodationPreviewEnd(entry.accommodationTypeId);
                        }}
                        onFocus={() => handleAccommodationPreviewStart(entry)}
                        onBlur={() => handleAccommodationPreviewEnd(entry.accommodationTypeId)}
                        disabled={isLoading}
                        aria-label={`Voir les photos de ${entry.name}`}
                        aria-busy={isLoading}
                        aria-describedby={isPreviewing ? `chatpreview-accsummary-preview-${entry.accommodationTypeId}` : undefined}
                      >
                        <span>
                          <span className="block font-medium text-ink">{entry.name}</span>
                          {entry.maxGuests !== null && (
                            <span className="block text-body/60">
                              Jusqu’à {entry.maxGuests} personne{entry.maxGuests > 1 ? "s" : ""}
                            </span>
                          )}
                        </span>
                        <span aria-hidden="true" className="shrink-0 text-base font-bold text-accent">
                          {isLoading ? "…" : "›"}
                        </span>
                      </button>

                      {isPreviewing && (
                        <div
                          id={`chatpreview-accsummary-preview-${entry.accommodationTypeId}`}
                          role="status"
                          className="absolute left-0 top-full z-20 mt-1 w-full max-w-[220px] rounded-lg border border-border bg-surface p-2 shadow-md"
                        >
                          <p className="font-medium text-ink">{entry.name}</p>
                          {previewError ? (
                            <p className="mt-1 text-body/60">Aperçu indisponible.</p>
                          ) : previewData === null ? (
                            <p className="mt-1 text-body/60">Chargement des photos…</p>
                          ) : previewData.photos.length === 0 ? (
                            <p className="mt-1 text-body/60">Aucune photo disponible.</p>
                          ) : (
                            <>
                              <div className="mt-1.5 flex gap-1">
                                {previewData.photos.slice(0, 4).map((photo, index) => (
                                  // eslint-disable-next-line @next/next/no-img-element -- externally-hosted storage thumbnail, not a local/optimizable asset.
                                  <img key={`${photo.url}-${index}`} src={photo.url} alt="" className="h-11 w-11 rounded object-cover" />
                                ))}
                              </div>
                              <p className="mt-1 text-body/60">
                                {previewData.photos.length} photo{previewData.photos.length > 1 ? "s" : ""}
                              </p>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {message.role === "assistant" && message.partnerRecommendations && message.partnerRecommendations.length > 0 && (
              <div className="flex max-w-[78%] flex-col gap-2">
                {message.partnerRecommendations.map((partner) => (
                  <div key={partner.id} className="rounded-lg border border-border bg-canvas px-3 py-2 text-2xs">
                    <p className="font-medium text-ink">{partner.name}</p>
                    {partner.description && <p className="mt-0.5 text-body/80">{partner.description}</p>}
                    {partner.address && <p className="mt-0.5 text-body/60">{partner.address}</p>}
                    {partner.phone && (
                      <a href={`tel:${partner.phone.replace(/[^+\d]/g, "")}`} className="mt-0.5 block text-body/60 hover:text-ink hover:underline">
                        {partner.phone}
                      </a>
                    )}
                    {partner.openingHours && <p className="mt-0.5 text-body/60">{partner.openingHours}</p>}
                    {partner.action && (
                      <a
                        href={partner.action.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1.5 inline-block rounded-full bg-ink px-3 py-1 text-2xs font-medium text-canvas hover:opacity-90"
                      >
                        {partner.action.label}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="max-w-[78%] self-start rounded-xl border border-border bg-surface px-3.5 py-2.5 text-xs text-body/60">
            {assistantName || "Assistant"} écrit…
          </div>
        )}

        {error && (
          <div className="self-start rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-xs text-danger">{error}</div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border p-3">
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSend();
          }}
          placeholder="Écrivez votre message…"
          disabled={loading}
          className="h-10 flex-1 rounded-full border border-border bg-surface px-4 text-xs outline-none focus:border-ink disabled:opacity-60"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={loading}
          aria-label="Envoyer"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink text-canvas disabled:opacity-60"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>

      {openRoomRecommendation && (
        <RoomPhotoModal
          name={openRoomRecommendation.name}
          photos={openRoomRecommendation.photos}
          pageUrl={openRoomRecommendation.pageUrl}
          bookingUrl={openRoomRecommendation.bookingUrl}
          onClose={() => setOpenRoomRecommendation(null)}
        />
      )}
    </div>
  );
}

/**
 * Admin-only debug panel — this component is never rendered in a public
 * widget, only in the admin dashboard's live preview and fullscreen test
 * mode. Shows source titles + similarity scores, never embeddings, prompt
 * text, or other internals.
 */
function SourcesDebugPanel({ answerStatus, sources }: { answerStatus: AnswerStatus; sources: MessageSource[] }) {
  if (answerStatus === "fallback") {
    return <p className="max-w-[78%] text-2xs italic text-body/55">Aucune source suffisamment pertinente.</p>;
  }

  if (answerStatus !== "answered" || sources.length === 0) return null;

  return (
    <div className="max-w-[78%] rounded-lg border border-border/70 bg-canvas px-3 py-2 text-2xs text-body/70">
      <p className="mb-1 font-medium text-body/80">Sources utilisées</p>
      <ul className="flex flex-col gap-0.5">
        {sources.map((source) => (
          <li key={source.sourceId}>
            • {source.sourceTitle} — {(source.similarity * 100).toFixed(0)}%
          </li>
        ))}
      </ul>
    </div>
  );
}
