"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { saveLoyaltySettings } from "./actions";
import type { LoyaltySettings } from "@/types/database";

export function LoyaltySettingsForm({ settings }: { settings: LoyaltySettings | null }) {
  const router = useRouter();
  const toast = useToast();
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [delayDays, setDelayDays] = useState(settings?.delay_days ?? 3);
  const [subject, setSubject] = useState(settings?.subject ?? "Merci pour votre séjour");
  const [content, setContent] = useState(settings?.content ?? "Merci d'avoir séjourné dans notre établissement. Nous espérons que votre séjour vous a plu.");
  const [pending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      const result = await saveLoyaltySettings({ enabled, delayDays, subject, content });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Réglages enregistrés.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-between">
        <span className="text-xs">Activer le suivi après séjour</span>
        <Toggle checked={enabled} onChange={setEnabled} label="Activer le suivi" />
      </div>
      <label className="text-xs">
        Délai après départ
        <input type="number" min="0" max="365" value={delayDays} onChange={(event) => setDelayDays(Number(event.target.value))} className="mt-2 h-10 w-full rounded-lg border border-border px-3" />
      </label>
      <label className="text-xs">
        Objet
        <input value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-border px-3" />
      </label>
      <label className="text-xs">
        Message
        <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={5} className="mt-2 w-full rounded-lg border border-border p-3" />
      </label>
      <p className="text-2xs text-body">Canal V1 : email.</p>
      <Button disabled={pending} onClick={handleSave}>
        {pending ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </div>
  );
}
