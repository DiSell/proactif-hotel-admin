"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { createCustomer } from "./actions";

export function CreateCustomerForm() {
  const router = useRouter();
  const toast = useToast();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await createCustomer({ firstName, lastName, email, phone });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.push(`/client/customers/${result.data!.id}`);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-3 md:grid-cols-5">
      <input name="first_name" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Prénom" className="h-10 rounded-lg border border-border px-3 text-xs" />
      <input name="last_name" value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Nom" className="h-10 rounded-lg border border-border px-3 text-xs" />
      <input name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="h-10 rounded-lg border border-border px-3 text-xs" />
      <input name="phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Téléphone" className="h-10 rounded-lg border border-border px-3 text-xs" />
      <button disabled={pending} className="rounded-lg bg-ink px-4 text-xs text-canvas disabled:opacity-60">
        {pending ? "Création…" : "Créer"}
      </button>
    </form>
  );
}
