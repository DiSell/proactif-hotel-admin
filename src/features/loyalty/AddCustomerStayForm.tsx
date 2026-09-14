"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { addCustomerStay } from "./actions";
import type { CustomerStayStatus } from "@/types/database";

export function AddCustomerStayForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [status, setStatus] = useState<CustomerStayStatus>("completed");
  const [externalReference, setExternalReference] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await addCustomerStay({ customerId, checkIn, checkOut, status, externalReference });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setCheckIn("");
      setCheckOut("");
      setExternalReference("");
      toast.show("Séjour ajouté.");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="mb-4 grid gap-2 md:grid-cols-5">
      <input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className="h-9 rounded-lg border border-border px-2 text-xs" />
      <input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} required className="h-9 rounded-lg border border-border px-2 text-xs" />
      <select value={status} onChange={(e) => setStatus(e.target.value as CustomerStayStatus)} className="h-9 rounded-lg border border-border px-2 text-xs">
        <option value="planned">Prévu</option>
        <option value="checked_in">En cours</option>
        <option value="completed">Terminé</option>
        <option value="cancelled">Annulé</option>
      </select>
      <input value={externalReference} onChange={(e) => setExternalReference(e.target.value)} placeholder="Référence" className="h-9 rounded-lg border border-border px-2 text-xs" />
      <button disabled={pending} className="rounded-lg bg-ink text-xs text-canvas disabled:opacity-60">
        {pending ? "Ajout…" : "Ajouter"}
      </button>
    </form>
  );
}
