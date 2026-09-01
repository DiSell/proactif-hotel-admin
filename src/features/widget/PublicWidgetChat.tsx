"use client";

import { useEffect, useState } from "react";
import { RoomPhotoModal } from "@/features/assistant/RoomPhotoModal";
import type { PublicWidgetConfig } from "./publicHotel";

type AnswerStatus = "answered" | "fallback" | "error" | "handoff";

interface RoomRecommendation {
  accommodationTypeId: string;
  name: string;
  photos: { url: string; alt: string | null }[];
  pageUrl: string | null;
  bookingUrl: string | null;
}

type ChatAction = { type: "booking"; label: string; url: string } | { type: "host_booking"; label: string };

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

interface ChatMessage {
  role: "assistant" | "user";
  content: string;
  answerStatus?: AnswerStatus;
  roomRecommendation?: RoomRecommendation | null;
  action?: ChatAction | null;
  partnerRecommendations?: PartnerRecommendation[];
}

/** Mirrors features/rag/types.ts's PendingPartnerRequestFields/PartnerRequestPhonePrompt — see those types' own doc comments. */
interface PendingPartnerRequestFields {
  partnerId: string;
  requestedDate: string | null;
  requestedTime: string | null;
  partySize: number | null;
  details: string | null;
  guestName: string | null;
}

interface PartnerRequestPhonePrompt {
  partnerName: string;
  pendingRequest: PendingPartnerRequestFields;
}

/** Mirrors features/rag/types.ts's PendingSpaBookingFields/SpaBookingPhonePrompt — see those types' own doc comments. */
interface PendingSpaBookingFields {
  bookingDate: string;
  slotStart: string;
  partySize: number;
  guestName: string | null;
  isNonResident: boolean;
  notes: string | null;
}

interface SpaBookingPhonePrompt {
  pendingBooking: PendingSpaBookingFields;
}

/**
 * The widget's own local union of the two structured-phone-form kinds this
 * component can show — never both at once (the backend guarantees
 * partnerRequestPhonePrompt/spaBookingPhonePrompt are never both non-null
 * the same turn). One shared form skeleton (JSX further below) branches on
 * `kind` for its label and submit target, rather than duplicating the whole
 * form block per kind.
 */
type ActivePhonePrompt = { kind: "partner_request"; prompt: PartnerRequestPhonePrompt } | { kind: "spa_booking"; prompt: SpaBookingPhonePrompt };

interface ChatApiResponse {
  conversationId: string;
  reply: string;
  answerStatus: AnswerStatus;
  roomRecommendation: RoomRecommendation | null;
  action: ChatAction | null;
  partnerRecommendations: PartnerRecommendation[];
  partnerRequestPhonePrompt: PartnerRequestPhonePrompt | null;
  spaBookingPhonePrompt: SpaBookingPhonePrompt | null;
}

interface PublicWidgetChatProps {
  widgetKey: string;
  config: PublicWidgetConfig;
  /**
   * The validated host page origin (see features/widget/hostOrigin.ts),
   * resolved server-side by page.tsx from the ?hostOrigin= query param
   * public/widget.js appends when it creates this iframe. null when
   * missing/invalid (e.g. this page opened directly, outside a real
   * widget.js embed) — in that case the host-booking CTA degrades
   * gracefully (see requestHostBooking) rather than ever falling back to
   * a wildcard postMessage targetOrigin.
   */
  hostOrigin: string | null;
}

const HOST_BOOKING_UNAVAILABLE_MESSAGE = "Le module de réservation n'a pas pu être ouvert. Vous pouvez utiliser le bouton Réserver du site.";
// Defensive only — see the effect below: guards against public/widget.js
// never replying (e.g. a version predating this feature cached on the
// host page), never a normal/expected wait.
const HOST_BOOKING_REPLY_TIMEOUT_MS = 4000;

/**
 * The closed reply vocabulary from public/widget.js's postResult() — a
 * pure, directly-testable shape check (unlike the event.source/event.origin
 * checks in the effect below, which need a real MessageEvent). Anything
 * else — wrong type, missing/foreign status, not an object — is not a
 * valid reply and is ignored.
 */
export function isValidBookingResultMessage(data: unknown): data is { type: "proactif:booking-result"; status: "triggered" | "unavailable" } {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  if (value.type !== "proactif:booking-result") return false;
  return value.status === "triggered" || value.status === "unavailable";
}

/**
 * Session token scheme (server half: features/widget/sessionToken.ts):
 * generated here with crypto.getRandomValues (256 bits, 64 hex chars),
 * stored RAW only in this browser's sessionStorage — never a cookie
 * (this page runs cross-origin inside a third-party site's iframe; relying
 * on a cookie would run straight into browsers blocking third-party
 * cookies/storage-partitioning), never a URL, never logged, never sent
 * anywhere except this widget's own chat endpoint. The server only ever
 * sees/stores SHA-256(token) — see sessionToken.ts — and requires it to
 * match (timing-safe) before treating any conversationId as belonging to
 * this visitor.
 *
 * sessionStorage scope: per browser TAB, per ORIGIN (this widget's own
 * origin, not the host page's — an iframe's storage is always scoped to
 * the iframe's own src origin). A refresh of the SAME tab/iframe keeps the
 * same token (and therefore the same conversation, via the persisted
 * conversationId below) — sessionStorage survives navigation/reload within
 * a tab. Opening the widget in a NEW tab, or the host page reloading the
 * iframe fresh in a way the browser treats as a new storage area, starts a
 * brand new session token and therefore a brand new conversation. This is
 * the deliberate, documented tradeoff: no persistence beyond the current
 * tab's lifetime, no third-party cookie dependency at all.
 *
 * Storage keys are namespaced by widgetKey (`...:${widgetKey}`) —
 * sessionStorage is scoped per ORIGIN only, not per widget, so if a single
 * top-level page ever embeds two different hotels' widgets (both iframes
 * loading from this same Proactif origin), unnamespaced keys would let
 * widget B read widget A's session token/conversationId on mount. The
 * server-side hotel_id check on conversation lookup (route.ts) already
 * prevented any actual cross-hotel data leak even before this — this fix
 * closes the client-side design gap so the two widgets never collide in
 * the first place, not just fail safely if they did.
 */
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

// Exported for direct testing (see PublicWidgetChat.sessionStorage.test.ts)
// — real unit tests over the actual namespacing logic, not just a claim in
// a comment.
export function sessionTokenStorageKey(widgetKey: string): string {
  return `proactif_widget_session_token:${widgetKey}`;
}

export function conversationIdStorageKey(widgetKey: string): string {
  return `proactif_widget_conversation_id:${widgetKey}`;
}

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    // sessionStorage can throw (privacy mode, storage blocked entirely for
    // this iframe) — treated as "nothing stored", never fatal.
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // Best-effort only — the widget still works for this page load even if
    // nothing can be persisted; continuity across a reload just won't
    // survive in that case.
  }
}

function clearStorage(key: string) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to do if storage is unavailable — see writeStorage.
  }
}

// Exported for direct testing — see PublicWidgetChat.sessionStorage.test.ts.
export function getOrCreateSessionToken(widgetKey: string): string {
  const key = sessionTokenStorageKey(widgetKey);
  const existing = readStorage(key);
  if (existing && SESSION_TOKEN_PATTERN.test(existing)) return existing;

  const bytes = new Uint8Array(32); // 256 bits
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  writeStorage(key, token);
  return token;
}

/**
 * Deliberately NOT a reuse of ChatPreview (features/assistant/ChatPreview.tsx)
 * — that component hardcodes the admin chat route (hotelId in the URL, an
 * admin-only endpoint) and is explicitly documented as never meant for a
 * public widget. This is a fresh, small, standalone component: calls the
 * public chat route by widgetKey only, uses the hotel's own colors (config)
 * instead of the admin dashboard's fixed theme tokens, and never assumes an
 * authenticated session. RoomPhotoModal is reused as-is — it's purely
 * presentational (no fetch, no auth), so pulling it in doesn't drag any
 * admin dependency along.
 */
export function PublicWidgetChat({ widgetKey, config, hostOrigin }: PublicWidgetChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: config.welcomeMessage }]);
  const [input, setInput] = useState("");
  // Lazy initializer: runs once, on the client only (typeof window guard —
  // this component still gets an initial server render during SSR/
  // hydration, where crypto.getRandomValues/sessionStorage don't exist).
  // Never rendered into HTML output, so there's no hydration mismatch from
  // the server pass returning "" and the client pass returning a real value.
  const [sessionToken] = useState<string>(() => (typeof window === "undefined" ? "" : getOrCreateSessionToken(widgetKey)));
  const [conversationId, setConversationId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readStorage(conversationIdStorageKey(widgetKey))
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openRoomRecommendation, setOpenRoomRecommendation] = useState<RoomRecommendation | null>(null);
  // The structured phone-collection form — a deterministic backend signal
  // (chat response's own partnerRequestPhonePrompt field), never something
  // inferred by parsing `reply`. Cleared explicitly on successful submit;
  // a later chat turn without the prompt also clears it (see handleSend),
  // so a stale form never lingers past the point it's no longer relevant.
  const [activePhonePrompt, setActivePhonePrompt] = useState<ActivePhonePrompt | null>(null);
  const [phoneInput, setPhoneInput] = useState("");
  const [phoneSubmitting, setPhoneSubmitting] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  // Tracks the one host-booking request in flight, if any, and which
  // message's button triggered it — never a booking, never a reservation,
  // just "did widget.js manage to open the site's existing module".
  const [hostBookingState, setHostBookingState] = useState<{ messageIndex: number; status: "pending" | "unavailable" } | null>(null);

  function requestHostBooking(messageIndex: number) {
    if (hostBookingState?.status === "pending") return; // one in flight at a time
    if (!hostOrigin) {
      // No validated host origin (e.g. this page opened outside a real
      // widget.js embed) — never fall back to "*"; just show the same
      // graceful fallback immediately, without ever calling postMessage.
      setHostBookingState({ messageIndex, status: "unavailable" });
      return;
    }
    setHostBookingState({ messageIndex, status: "pending" });
    window.parent.postMessage({ type: "proactif:booking" }, hostOrigin);
  }

  // Only listens while a request is actually pending — no listener sits
  // around for the component's whole lifetime.
  useEffect(() => {
    if (!hostBookingState || hostBookingState.status !== "pending" || !hostOrigin) return;

    function handleMessage(event: MessageEvent) {
      if (event.source !== window.parent) return;
      if (event.origin !== hostOrigin) return;
      if (!isValidBookingResultMessage(event.data)) return;

      if (event.data.status === "unavailable") {
        setHostBookingState((current) => (current && current.status === "pending" ? { ...current, status: "unavailable" } : current));
      } else {
        // "triggered": widget.js already reduced/closed the whole Proactif
        // panel on the host page — nothing left to reflect here.
        setHostBookingState(null);
      }
    }

    window.addEventListener("message", handleMessage);
    // Defensive only (see HOST_BOOKING_REPLY_TIMEOUT_MS's own comment) —
    // never leaves the visitor staring at a button that silently did
    // nothing if a stale/older widget.js on the host page never replies.
    const timeoutId = window.setTimeout(() => {
      setHostBookingState((current) => (current && current.status === "pending" ? { ...current, status: "unavailable" } : current));
    }, HOST_BOOKING_REPLY_TIMEOUT_MS);

    return () => {
      window.removeEventListener("message", handleMessage);
      window.clearTimeout(timeoutId);
    };
  }, [hostBookingState, hostOrigin]);

  function updateConversationId(id: string) {
    setConversationId(id);
    writeStorage(conversationIdStorageKey(widgetKey), id);
  }

  function forgetConversation() {
    setConversationId(null);
    clearStorage(conversationIdStorageKey(widgetKey));
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || loading || !sessionToken) return;
    setInput("");
    setError(null);
    // A new chat message means the visitor is continuing the conversation
    // (possibly by typing their phone number in free text — the safety net
    // in phoneRedaction.ts still applies server-side either way) — any
    // previously-shown phone form is no longer the current turn's own, so
    // it's cleared here and re-shown fresh only if this turn's own response
    // asks for it again.
    setActivePhonePrompt(null);
    setPhoneError(null);
    setMessages((current) => [...current, { role: "user", content: trimmed }]);
    setLoading(true);

    try {
      const response = await fetch(`/api/widget/${encodeURIComponent(widgetKey)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message: trimmed, sessionToken }),
      });

      if (!response.ok) {
        // A stale/foreign conversationId (e.g. left over from a corrupted
        // or previously-cleared session) is self-healing: forget it and
        // let the next send start a fresh conversation, rather than
        // repeating the same failure forever.
        if (response.status === 404 && conversationId) {
          forgetConversation();
        }
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Une erreur est survenue.");
      }

      const data: ChatApiResponse = await response.json();
      updateConversationId(data.conversationId);
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: data.reply,
          answerStatus: data.answerStatus,
          roomRecommendation: data.roomRecommendation,
          action: data.action,
          partnerRecommendations: data.partnerRecommendations,
        },
      ]);
      if (data.partnerRequestPhonePrompt) {
        setActivePhonePrompt({ kind: "partner_request", prompt: data.partnerRequestPhonePrompt });
      } else if (data.spaBookingPhonePrompt) {
        setActivePhonePrompt({ kind: "spa_booking", prompt: data.spaBookingPhonePrompt });
      } else {
        setActivePhonePrompt(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue.");
    } finally {
      setLoading(false);
    }
  }

  /**
   * The structured phone form's own submit — deliberately NOT handleSend:
   * the phone is never sent as a normal chat message (never persisted to
   * messages.content, never seen by the model) — see
   * src/app/api/widget/[widgetKey]/partner-request/phone/route.ts. Guarded
   * against double-submit the same way handleSend guards against it
   * (an in-flight-request boolean checked at the top).
   */
  async function handleSubmitPhone() {
    const trimmed = phoneInput.trim();
    if (!trimmed || phoneSubmitting || !activePhonePrompt || !conversationId || !sessionToken) return;
    setPhoneSubmitting(true);
    setPhoneError(null);

    try {
      const path = activePhonePrompt.kind === "partner_request" ? "partner-request/phone" : "spa-booking/phone";
      const requestBody =
        activePhonePrompt.kind === "partner_request"
          ? { conversationId, sessionToken, phone: trimmed, pendingRequest: activePhonePrompt.prompt.pendingRequest }
          : { conversationId, sessionToken, phone: trimmed, pendingBooking: activePhonePrompt.prompt.pendingBooking };

      const response = await fetch(`/api/widget/${encodeURIComponent(widgetKey)}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "Une erreur est survenue.");
      }

      // Success: the form disappears, and the deterministic recap/resume
      // text the server just produced is appended as a new assistant-style
      // message — never the raw phone number, only ever the server's own
      // masked-phone recap (see partnerRequestFlow.ts's buildRecapText).
      setMessages((current) => [...current, { role: "assistant", content: body.message }]);
      setActivePhonePrompt(null);
      setPhoneInput("");
    } catch (err) {
      setPhoneError(err instanceof Error ? err.message : "Une erreur est survenue.");
    } finally {
      setPhoneSubmitting(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        maxHeight: "100vh",
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#FBFAF7",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: config.primaryColor, flexShrink: 0 }}>
        <div
          style={{
            display: "flex",
            height: 32,
            width: 32,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 9999,
            background: config.secondaryColor,
            color: config.primaryColor,
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {config.assistantName.slice(0, 1).toUpperCase() || "A"}
        </div>
        <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: config.secondaryColor }}>{config.assistantName}</p>
      </div>

      {config.activeBanner && (
        <div
          style={{
            display: "flex",
            gap: 8,
            padding: "10px 16px",
            background: "#FFF4E5",
            borderBottom: "1px solid #F0DDBB",
            fontSize: 12,
            lineHeight: 1.4,
            color: "#6B4A16",
            flexShrink: 0,
          }}
        >
          <span aria-hidden="true">⚠️</span>
          <span>
            <strong>{config.activeBanner.title}</strong>
            {config.activeBanner.content ? ` — ${config.activeBanner.content}` : ""}
          </span>
        </div>
      )}

      <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 12, overflowY: "auto", padding: 16 }}>
        {messages.map((message, index) => (
          <div key={index} style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: message.role === "user" ? "flex-end" : "flex-start" }}>
            <div
              style={{
                maxWidth: "82%",
                borderRadius: message.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                padding: "10px 14px",
                fontSize: 13,
                lineHeight: 1.5,
                background: message.role === "user" ? config.primaryColor : "#fff",
                color: message.role === "user" ? config.secondaryColor : "#1A1D1A",
                border: message.role === "user" ? "none" : "1px solid #E5E1D8",
              }}
            >
              {message.content}
            </div>
            {message.role === "assistant" && message.roomRecommendation && (
              <button
                type="button"
                onClick={() => setOpenRoomRecommendation(message.roomRecommendation ?? null)}
                style={{
                  maxWidth: "82%",
                  borderRadius: 8,
                  border: "1px solid #E5E1D8",
                  background: "#fff",
                  padding: "8px 12px",
                  textAlign: "left",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "#1A1D1A",
                  cursor: "pointer",
                }}
              >
                Voir la chambre — {message.roomRecommendation.name}
              </button>
            )}
            {/* Server guarantees roomRecommendation and a "booking" action are never both present for the same turn (a duplicate link would result) — but "host_booking" CAN coexist with a roomRecommendation, precisely when the hotel is in host_widget mode and RoomPhotoModal has no button of its own to offer (see answer.ts's answerGrounded). */}
            {message.role === "assistant" && message.action?.type === "booking" && (
              <a
                href={message.action.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  maxWidth: "82%",
                  borderRadius: 9999,
                  background: config.primaryColor,
                  color: config.secondaryColor,
                  padding: "8px 16px",
                  textAlign: "center",
                  fontSize: 12,
                  fontWeight: 500,
                  textDecoration: "none",
                }}
              >
                {message.action.label}
              </a>
            )}
            {message.role === "assistant" && message.action?.type === "host_booking" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                <button
                  type="button"
                  onClick={() => requestHostBooking(index)}
                  style={{
                    maxWidth: "82%",
                    borderRadius: 9999,
                    border: "none",
                    background: config.primaryColor,
                    color: config.secondaryColor,
                    padding: "8px 16px",
                    textAlign: "center",
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: "pointer",
                  }}
                >
                  {message.action.label}
                </button>
                {hostBookingState?.messageIndex === index && hostBookingState.status === "unavailable" && (
                  <p style={{ margin: 0, maxWidth: "82%", fontSize: 11, lineHeight: 1.5, color: "#B23B3B" }}>{HOST_BOOKING_UNAVAILABLE_MESSAGE}</p>
                )}
              </div>
            )}
            {message.role === "assistant" && message.partnerRecommendations && message.partnerRecommendations.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: "82%" }}>
                {message.partnerRecommendations.map((partner) => (
                  <div key={partner.id} style={{ borderRadius: 8, border: "1px solid #E5E1D8", background: "#fff", padding: "8px 12px", fontSize: 12 }}>
                    <p style={{ margin: 0, fontWeight: 500, color: "#1A1D1A" }}>{partner.name}</p>
                    {partner.description && (
                      <p style={{ margin: "2px 0 0", color: "#4A4E48" }}>{partner.description}</p>
                    )}
                    {partner.address && <p style={{ margin: "2px 0 0", color: "#6b6b6b" }}>{partner.address}</p>}
                    {partner.phone && (
                      <a
                        href={`tel:${partner.phone.replace(/[^+\d]/g, "")}`}
                        style={{ display: "block", margin: "2px 0 0", color: "#6b6b6b", textDecoration: "none" }}
                      >
                        {partner.phone}
                      </a>
                    )}
                    {partner.openingHours && <p style={{ margin: "2px 0 0", color: "#6b6b6b" }}>{partner.openingHours}</p>}
                    {partner.action && (
                      <a
                        href={partner.action.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          display: "inline-block",
                          marginTop: 6,
                          borderRadius: 9999,
                          background: config.primaryColor,
                          color: config.secondaryColor,
                          padding: "6px 14px",
                          fontSize: 11,
                          fontWeight: 500,
                          textDecoration: "none",
                        }}
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

        {activePhonePrompt && (
          <div
            style={{
              display: "flex",
              maxWidth: "82%",
              flexDirection: "column",
              gap: 8,
              alignSelf: "flex-start",
              borderRadius: 12,
              border: "1px solid #E5E1D8",
              background: "#fff",
              padding: "12px 14px",
            }}
          >
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#1A1D1A" }}>
              {activePhonePrompt.kind === "partner_request"
                ? `À quel numéro souhaitez-vous recevoir la réponse de ${activePhonePrompt.prompt.partnerName} ?`
                : "Merci de communiquer votre numéro de téléphone pour confirmer votre réservation spa."}
            </p>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phoneInput}
              onChange={(event) => {
                setPhoneInput(event.target.value);
                setPhoneError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSubmitPhone();
              }}
              placeholder="06 12 34 56 78"
              disabled={phoneSubmitting}
              style={{
                height: 40,
                borderRadius: 8,
                border: "1px solid #E5E1D8",
                padding: "0 12px",
                fontSize: 13,
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "#6b6b6b" }}>
              {activePhonePrompt.kind === "partner_request"
                ? "Votre numéro sera utilisé uniquement pour transmettre cette demande et vous communiquer la réponse du partenaire."
                : "Votre numéro sera utilisé uniquement pour confirmer votre réservation et vous contacter si nécessaire."}
            </p>
            {phoneError && <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "#B23B3B" }}>{phoneError}</p>}
            <button
              type="button"
              onClick={handleSubmitPhone}
              disabled={phoneSubmitting || phoneInput.trim().length === 0}
              style={{
                height: 36,
                borderRadius: 9999,
                border: "none",
                background: config.primaryColor,
                color: config.secondaryColor,
                fontSize: 12,
                fontWeight: 500,
                cursor: phoneSubmitting ? "default" : "pointer",
                opacity: phoneSubmitting || phoneInput.trim().length === 0 ? 0.6 : 1,
              }}
            >
              {phoneSubmitting ? "Envoi…" : "Continuer"}
            </button>
          </div>
        )}

        {loading && (
          <div style={{ maxWidth: "82%", alignSelf: "flex-start", borderRadius: 12, border: "1px solid #E5E1D8", background: "#fff", padding: "10px 14px", fontSize: 13, color: "#6b6b6b" }}>
            {config.assistantName} écrit…
          </div>
        )}

        {error && (
          <div style={{ alignSelf: "flex-start", borderRadius: 12, border: "1px solid #E8B4B4", background: "#FBEAEA", padding: "10px 14px", fontSize: 13, color: "#B23B3B" }}>
            {error}
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid #E5E1D8", padding: 12, flexShrink: 0 }}>
        <input
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSend();
          }}
          placeholder="Écrivez votre message…"
          disabled={loading}
          style={{
            height: 40,
            flex: 1,
            borderRadius: 9999,
            border: "1px solid #E5E1D8",
            background: "#fff",
            padding: "0 16px",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={loading}
          aria-label="Envoyer"
          style={{
            display: "flex",
            height: 40,
            width: 40,
            flexShrink: 0,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 9999,
            border: "none",
            background: config.primaryColor,
            color: config.secondaryColor,
            cursor: loading ? "default" : "pointer",
            opacity: loading ? 0.6 : 1,
          }}
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
