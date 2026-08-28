"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { setPhotoManagementMode } from "./actions";
import type { PhotoManagementMode } from "./schema";

const OPTIONS: { value: PhotoManagementMode; label: string; description: string }[] = [
  {
    value: "client",
    label: "Je gère mes photos",
    description: "Vous choisissez vous-même les photos affichées dans votre chatbot, depuis cette page.",
  },
  {
    value: "proactif",
    label: "Je délègue la gestion à Proactif System",
    description: "L’équipe Proactif sélectionne les photos à votre place — vous gardez toujours cette page pour voir et ajuster ses choix.",
  },
];

/** Client-only decision — see features/client/actions.ts:setPhotoManagementMode's own comment on why there's no superadmin equivalent. */
export function PhotoManagementModeToggle({ mode }: { mode: PhotoManagementMode }) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState(mode);

  function choose(next: PhotoManagementMode) {
    if (next === selected || isPending) return;
    const previous = selected;
    setSelected(next);
    startTransition(async () => {
      const result = await setPhotoManagementMode(next);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        setSelected(previous);
        return;
      }
      toast.show("Préférence enregistrée.");
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Gestion des photos du chatbot</span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => choose(option.value)}
            disabled={isPending}
            aria-pressed={selected === option.value}
            className={`flex flex-col gap-1 rounded-lg border p-3 text-left disabled:opacity-60 ${
              selected === option.value ? "border-ink bg-canvas" : "border-border hover:border-ink/40"
            }`}
          >
            <span className="text-xs font-medium text-ink">{option.label}</span>
            <span className="text-2xs text-body/60">{option.description}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
