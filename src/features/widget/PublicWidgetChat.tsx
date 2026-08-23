"use client";

import { useState } from "react";
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

interface ChatAction {
  type: "booking";
  label: string;
  url: string;
}

interface ChatMessage {
  role: "assistant" | "user";
  content: string;
  answerStatus?: AnswerStatus;
  roomRecommendation?: RoomRecommendation | null;
  action?: ChatAction | null;
}

interface ChatApiResponse {
  conversationId: string;
  reply: string;
  answerStatus: AnswerStatus;
  roomRecommendation: RoomRecommendation | null;
  action: ChatAction | null;
}

interface PublicWidgetChatProps {
  widgetKey: string;
  config: PublicWidgetConfig;
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
export function PublicWidgetChat({ widgetKey, config }: PublicWidgetChatProps) {
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
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Une erreur est survenue.");
    } finally {
      setLoading(false);
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
            {/* Server guarantees roomRecommendation and action are never both present for the same turn — no dedup needed here (see answer.ts's buildBookingAction). */}
            {message.role === "assistant" && message.action && (
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
          </div>
        ))}

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
