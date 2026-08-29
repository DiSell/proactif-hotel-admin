"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { generateWhatsAppActivationLinkBackoffice } from "./actions";

/**
 * Admin-only — generates/copies a WhatsApp activation link, never opens
 * Meta's Embedded Signup itself (task: "NE PAS ouvrir Meta depuis le
 * dashboard admin"). The raw link is held ONLY in this component's own
 * local state, for exactly this one render after generation — it is never
 * re-fetched from the server afterward (getHotelWhatsAppActivationLinkStatus,
 * queries.ts, deliberately never returns the raw token). A page reload
 * loses it; "Régénérer le lien" is the only way to get a usable link again.
 */
export function GenerateActivationLinkButton({ hotelId, hasPendingLink }: { hotelId: string; hasPendingLink: boolean }) {
  const toast = useToast();
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleGenerate() {
    setLoading(true);
    const result = await generateWhatsAppActivationLinkBackoffice(hotelId);
    setLoading(false);
    if (!result.ok || !result.data) {
      toast.show(result.error ?? "Erreur", "danger");
      return;
    }
    setLink(result.data.url);
  }

  async function handleCopy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.show("Lien copié.");
    } catch {
      toast.show("Impossible de copier le lien.", "danger");
    }
  }

  if (link) {
    return (
      <div>
        <p className="text-xs font-medium text-ink">Lien d&rsquo;activation généré</p>
        <p className="mt-1 mb-3 break-all rounded-lg border border-border bg-canvas px-3 py-2 text-2xs text-body">{link}</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={handleCopy}>
            Copier le lien
          </Button>
          <Button variant="secondary" size="sm" onClick={handleGenerate} disabled={loading}>
            {loading ? "Génération…" : "Régénérer le lien"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleGenerate} disabled={loading}>
      {loading ? "Génération…" : hasPendingLink ? "Régénérer le lien" : "Générer un lien d'activation"}
    </Button>
  );
}
