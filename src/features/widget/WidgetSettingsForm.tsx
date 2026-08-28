"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { Toggle } from "@/components/ui/Toggle";
import { Button } from "@/components/ui/Button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { useToast } from "@/components/ui/Toast";
import { saveWidgetSettings } from "./actions";
import { buildWidgetSnippet } from "./embedSnippet";
import { WidgetPreview } from "./WidgetPreview";
import type { Hotel, WidgetSettings, WidgetPosition, WidgetIcon } from "@/types/database";

const POSITIONS: WidgetPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

interface WidgetSettingsFormProps {
  hotel: Hotel;
  settings: WidgetSettings | null;
}

export function WidgetSettingsForm({ hotel, settings }: WidgetSettingsFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [position, setPosition] = useState<WidgetPosition>(settings?.position ?? "bottom-right");
  const [icon, setIcon] = useState<WidgetIcon>(settings?.icon ?? "chat");
  const [welcomeMessage, setWelcomeMessage] = useState(settings?.welcome_message ?? "Bonjour ! Comment puis-je vous aider ?");
  const [isActive, setIsActive] = useState(settings?.is_active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const snippet = buildWidgetSnippet(hotel.widget_key);

  function handleSubmit() {
    startTransition(async () => {
      const result = await saveWidgetSettings(hotel.id, {
        position,
        icon,
        welcome_message: welcomeMessage,
        is_active: isActive,
      });
      if (!result.ok) {
        setError(result.error ?? "Erreur");
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setError(null);
      toast.show("Modifications enregistrées.");
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_420px]">
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Apparence</span>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium" style={{ color: isActive ? "var(--color-success)" : "var(--color-body)" }}>
            {isActive ? "Widget actif" : "Widget inactif"}
          </span>
          <Toggle checked={isActive} onChange={setIsActive} label="Widget actif" />
        </div>
      </div>

      <FormField label="Position" htmlFor="position">
        <div className="flex gap-2">
          {POSITIONS.map((pos) => (
            <button
              key={pos}
              type="button"
              onClick={() => setPosition(pos)}
              aria-pressed={position === pos}
              className="relative h-11 w-14 rounded-lg border"
              style={{ borderColor: position === pos ? "var(--color-ink)" : "var(--color-border)" }}
            >
              <span
                className="absolute h-2.5 w-3 rounded-sm"
                style={{
                  backgroundColor: position === pos ? "var(--color-ink)" : "rgba(74,78,72,.3)",
                  top: pos.startsWith("top") ? 4 : undefined,
                  bottom: pos.startsWith("bottom") ? 4 : undefined,
                  left: pos.endsWith("left") ? 4 : undefined,
                  right: pos.endsWith("right") ? 4 : undefined,
                }}
              />
            </button>
          ))}
        </div>
      </FormField>

      <FormField label="Icône du bouton" htmlFor="icon">
        <div className="flex gap-2">
          {(["chat", "message", "help"] as WidgetIcon[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setIcon(value)}
              aria-pressed={icon === value}
              className="flex h-11 w-11 items-center justify-center rounded-lg border text-body"
              style={{ borderColor: icon === value ? "var(--color-ink)" : "var(--color-border)", color: icon === value ? "var(--color-ink)" : undefined }}
            >
              {value === "chat" && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 5h16v11H8l-4 4V5z" />
                </svg>
              )}
              {value === "message" && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.4-4 8-9 8a10 10 0 01-4-.8L3 20l1-3.8A7.6 7.6 0 013 12c0-4.4 4-8 9-8s9 3.6 9 8z" />
                </svg>
              )}
              {value === "help" && (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M9.5 9.5a2.5 2.5 0 013-2.4c1.2.25 2 1.3 2 2.4 0 1.6-2 1.8-2 3.5" />
                  <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
                </svg>
              )}
            </button>
          ))}
        </div>
      </FormField>

      <FormField label="Message d’accueil du widget" htmlFor="welcome_message" required>
        <input
          id="welcome_message"
          value={welcomeMessage}
          onChange={(event) => setWelcomeMessage(event.target.value)}
          className={inputClassName()}
        />
      </FormField>

      {error && <p className="text-2xs text-danger">{error}</p>}

      <Button variant="primary" onClick={handleSubmit} disabled={isPending} className="w-fit">
        {isPending ? "Enregistrement…" : "Enregistrer"}
      </Button>

      <div className="flex flex-col gap-4 border-t border-border pt-6">
        <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Intégration</span>
        <FormField label="Clé publique" htmlFor="widget_key">
          <div className="flex h-10 items-center rounded-lg border border-border bg-canvas px-3">
            <span className="truncate font-mono text-xs text-body">{hotel.widget_key}</span>
          </div>
        </FormField>
        <div>
          <p className="mb-2 text-xs font-medium text-ink">Code d’intégration</p>
          <CodeBlock>{snippet}</CodeBlock>
          <div className="mt-3">
            <CopyButton value={snippet} />
          </div>
        </div>
      </div>
    </div>

    <div className="flex flex-col gap-3">
      <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Aperçu en direct</span>
      <WidgetPreview
        position={position}
        icon={icon}
        welcomeMessage={welcomeMessage}
        primaryColor={hotel.primary_color ?? "#1A1D1A"}
        secondaryColor={hotel.secondary_color ?? "#8A6A3E"}
        assistantName={hotel.assistant_name ?? "Assistant"}
      />
    </div>
    </div>
  );
}
