"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Toggle } from "@/components/ui/Toggle";
import { useToast } from "@/components/ui/Toast";
import { updateCustomerCommunication } from "./actions";

interface CustomerCommunicationFormProps {
  customerId: string;
  marketingAllowed: boolean;
  hotelExcluded: boolean;
  customerUnsubscribed: boolean;
  exclusionReason: string | null;
}

export function CustomerCommunicationForm({ customerId, marketingAllowed: initialMarketing, hotelExcluded: initialExcluded, customerUnsubscribed, exclusionReason }: CustomerCommunicationFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [marketingAllowed, setMarketingAllowed] = useState(initialMarketing);
  const [hotelExcluded, setHotelExcluded] = useState(initialExcluded);
  const [reason, setReason] = useState(exclusionReason ?? "");
  const [pending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      const result = await updateCustomerCommunication({ customerId, marketingAllowed, hotelExcluded, exclusionReason: reason });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Préférences enregistrées.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium">Marketing autorisé</p>
          <p className="text-2xs text-body">Fail-closed : désactivé par défaut.</p>
        </div>
        <Toggle checked={marketingAllowed} onChange={setMarketingAllowed} label="Marketing autorisé" disabled={customerUnsubscribed} />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-medium">Exclusion décidée par l&rsquo;hôtel</p>
          <p className="text-2xs text-body">Bloque les campagnes et le suivi après séjour.</p>
        </div>
        <Toggle checked={hotelExcluded} onChange={setHotelExcluded} label="Exclusion hôtel" />
      </div>
      {hotelExcluded && (
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Motif facultatif" className="h-10 rounded-lg border border-border px-3 text-xs" />
      )}
      <div className="rounded-lg border border-border bg-canvas p-3 text-xs">
        <strong>Désinscription client :</strong> {customerUnsubscribed ? "Oui — blocage prioritaire non modifiable ici" : "Non"}
      </div>
      <Button disabled={pending} onClick={handleSave}>
        {pending ? "Enregistrement…" : "Enregistrer"}
      </Button>
    </div>
  );
}
