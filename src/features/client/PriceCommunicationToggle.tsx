"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { setAllowPriceCommunication } from "./actions";

const OPTIONS: { value: boolean; label: string; description: string }[] = [
  {
    value: false,
    label: "Désactivé",
    description: "Camille ne communique aucun tarif.",
  },
  {
    value: true,
    label: "Activé",
    description: "Camille peut communiquer les tarifs provenant de sources tarifaires autorisées par Proactif Hospitality.",
  },
];

/**
 * Client-editable — the ONE chatbot_settings field a hotel_admin may change
 * themselves (see features/client/actions.ts:setAllowPriceCommunication's
 * own doc comment). Mirrors PhotoManagementModeToggle's own optimistic-
 * update-with-rollback shape exactly, adapted to a boolean instead of an
 * enum. Deliberately never promises "tous les prix" — the copy below
 * matches exactly what the setting actually guarantees (see
 * features/rag/pricePolicy.ts's own doc comment on what ON really means).
 */
export function PriceCommunicationToggle({ allowPriceCommunication }: { allowPriceCommunication: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState(allowPriceCommunication);

  function choose(next: boolean) {
    if (next === selected || isPending) return;
    const previous = selected;
    setSelected(next);
    startTransition(async () => {
      const result = await setAllowPriceCommunication(next);
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
      <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Autoriser Camille à communiquer les tarifs</span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {OPTIONS.map((option) => (
          <button
            key={String(option.value)}
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
