"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { cancelCampaign } from "./actions";

export function CancelCampaignButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  function handleCancel() {
    startTransition(async () => {
      const result = await cancelCampaign(id);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Campagne annulée.");
      router.refresh();
    });
  }

  return (
    <Button variant="danger" disabled={pending} onClick={handleCancel}>
      {pending ? "Annulation…" : "Annuler la campagne"}
    </Button>
  );
}
