"use client";

import { useState } from "react";
import { getSimulatedReply } from "./getSimulatedReply";

interface ChatMessage {
  role: "assistant" | "user";
  content: string;
}

interface ChatPreviewProps {
  assistantName: string;
  welcomeMessage: string;
  fullScreen?: boolean;
}

export function ChatPreview({ assistantName, welcomeMessage, fullScreen }: ChatPreviewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: welcomeMessage }]);
  const [input, setInput] = useState("");

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    setInput("");
    setMessages((current) => [...current, { role: "user", content: trimmed }]);
    // Simulated — see getSimulatedReply.ts. Not a real request.
    setTimeout(() => {
      setMessages((current) => [...current, { role: "assistant", content: getSimulatedReply(trimmed, assistantName) }]);
    }, 500);
  }

  function handleReset() {
    setMessages([{ role: "assistant", content: welcomeMessage }]);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-3 bg-ink px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-canvas">
          {assistantName.slice(0, 1).toUpperCase() || "A"}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-canvas">{assistantName || "Assistant"}</p>
          <p className="text-2xs text-canvas/55">Aperçu de test (simulé)</p>
        </div>
        <button type="button" onClick={handleReset} className="text-2xs font-medium text-canvas/70 hover:text-canvas">
          Vider
        </button>
      </div>

      <div className={`flex flex-1 flex-col gap-3 overflow-y-auto p-4 ${fullScreen ? "" : "min-h-[320px]"}`}>
        {messages.map((message, index) => (
          <div
            key={index}
            className={`max-w-[78%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
              message.role === "user" ? "self-end bg-ink text-canvas" : "self-start border border-border bg-surface"
            }`}
            style={{
              borderRadius: message.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
            }}
          >
            {message.content}
          </div>
        ))}
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
          className="h-10 flex-1 rounded-full border border-border bg-surface px-4 text-xs outline-none focus:border-ink"
        />
        <button
          type="button"
          onClick={handleSend}
          aria-label="Envoyer"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink text-canvas"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
