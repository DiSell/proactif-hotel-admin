"use client";

import { FormField } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { buildWidgetSnippet } from "./embedSnippet";
import type { Hotel, WidgetSettings } from "@/types/database";

interface ClientWidgetInfoProps {
  hotel: Hotel;
  widgetSettings: WidgetSettings | null;
}

/**
 * Read-only — the client portal never edits widget settings (position,
 * icon, welcome message stay an admin-only concern, see
 * WidgetSettingsForm.tsx). Shows exactly widget_key (the public,
 * non-secret identifier meant to be pasted onto the hotel's own site —
 * see lib/widgetKey.ts's generateWidgetKey doc comment) and the same
 * snippet the back-office shows, built from the one shared
 * buildWidgetSnippet() — never any server-only secret or internal field.
 */
export function ClientWidgetInfo({ hotel, widgetSettings }: ClientWidgetInfoProps) {
  const isActive = widgetSettings ? widgetSettings.is_active : true;
  const snippet = buildWidgetSnippet(hotel.widget_key);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Statut du widget</span>
        <StatusBadge label={isActive ? "Actif" : "Inactif"} tone={isActive ? "success" : "neutral"} />
      </div>

      <FormField label="Clé publique du widget" htmlFor="client_widget_key">
        <div className="flex h-10 items-center rounded-lg border border-border bg-canvas px-3">
          <span className="truncate font-mono text-xs text-body">{hotel.widget_key}</span>
        </div>
      </FormField>

      <div>
        <p className="mb-2 text-xs font-medium text-ink">Code d&rsquo;intégration</p>
        <p className="mb-2 text-2xs text-body">Ajoutez ce script avant &lt;/body&gt; sur votre site :</p>
        <CodeBlock>{snippet}</CodeBlock>
        <div className="mt-3">
          <CopyButton value={snippet} />
        </div>
      </div>

      <Button href="/client/chatbot" variant="primary" className="w-fit">
        Tester mon chatbot
      </Button>
    </div>
  );
}
