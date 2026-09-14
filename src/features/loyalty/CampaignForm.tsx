"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createCampaign } from "./actions";
import type { HotelCustomer } from "@/types/database";

type Row = HotelCustomer & { eligibility: { eligible: true } | { eligible: false; reason: string } };

export function CampaignForm({ customers }: { customers: Row[] }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [offer, setOffer] = useState("");
  const [audience, setAudience] = useState<"general" | "targeted">("general");
  const [selected, setSelected] = useState<string[]>([]);
  const [scheduled, setScheduled] = useState("");
  const [preview, setPreview] = useState(false);
  const [pending, startTransition] = useTransition();

  const pool = audience === "general" ? customers : customers.filter((c) => selected.includes(c.id));
  const counts = useMemo(
    () => ({
      selected: audience === "general" ? customers.length : selected.length,
      eligible: pool.filter((c) => c.eligibility.eligible).length,
      excluded: pool.filter((c) => !c.eligibility.eligible).length,
    }),
    [audience, customers, pool, selected.length]
  );

  function handleSubmit() {
    startTransition(async () => {
      const result = await createCampaign({
        internalName: name,
        subject,
        content,
        offerText: offer || null,
        audienceType: audience,
        scheduledAt: scheduled ? new Date(scheduled).toISOString() : null,
        customerIds: selected,
      });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.push(`/client/loyalty/campaigns/${result.data!.id}`);
    });
  }

  if (!preview) {
    return (
      <div className="flex flex-col gap-4">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom interne" className="h-10 rounded-lg border border-border px-3 text-xs" />
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Objet" className="h-10 rounded-lg border border-border px-3 text-xs" />
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Contenu" rows={6} className="rounded-lg border border-border p-3 text-xs" />
        <textarea value={offer} onChange={(e) => setOffer(e.target.value)} placeholder="Offre facultative" rows={3} className="rounded-lg border border-border p-3 text-xs" />
        <select value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)} className="h-10 rounded-lg border border-border px-3 text-xs">
          <option value="general">Tous les clients éligibles</option>
          <option value="targeted">Sélection de clients</option>
        </select>
        {audience === "targeted" && (
          <div className="max-h-64 overflow-auto rounded-lg border border-border p-3">
            {customers.map((c) => (
              <label key={c.id} className="flex items-center gap-2 border-b border-border py-2 text-xs">
                <input
                  type="checkbox"
                  checked={selected.includes(c.id)}
                  onChange={(e) => setSelected((s) => (e.target.checked ? [...s, c.id] : s.filter((id) => id !== c.id)))}
                />
                <span>{[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email}</span>
                {!c.eligibility.eligible && <span className="text-danger">Exclu à l&rsquo;envoi</span>}
              </label>
            ))}
          </div>
        )}
        <label className="text-xs">
          Date d&rsquo;envoi (laisser vide pour brouillon)
          <input type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} className="mt-2 h-10 w-full rounded-lg border border-border px-3" />
        </label>
        <Button onClick={() => setPreview(true)}>Aperçu</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold">{subject}</h3>
      <p className="whitespace-pre-wrap text-xs">{content}</p>
      {offer && <p className="rounded-lg bg-canvas p-3 text-xs font-medium">{offer}</p>}
      <div className="grid grid-cols-3 gap-3 text-xs">
        <p>Sélectionnés : {counts.selected}</p>
        <p>Éligibles : {counts.eligible}</p>
        <p>Exclus : {counts.excluded}</p>
      </div>
      <p className="text-xs">Envoi : {scheduled || "Brouillon"} — Canal : email</p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setPreview(false)}>
          Modifier
        </Button>
        <Button disabled={pending} onClick={handleSubmit}>
          {pending ? "Validation…" : "Valider"}
        </Button>
      </div>
    </div>
  );
}
