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
  const [thankYouEnabled, setThankYouEnabled] = useState(settings?.thank_you_enabled ?? true);
  const [subject, setSubject] = useState(settings?.subject ?? "Merci pour votre séjour");
  const [content, setContent] = useState(settings?.content ?? "Merci d'avoir séjourné dans notre établissement. Nous espérons que votre séjour vous a plu.");
  const [reviewEnabled, setReviewEnabled] = useState(settings?.review_enabled ?? false);
  const [reviewContent, setReviewContent] = useState(settings?.review_content ?? "Votre avis nous serait précieux.");
  const [reviewUrl, setReviewUrl] = useState(settings?.review_url ?? "");
  const [reviewButtonLabel, setReviewButtonLabel] = useState(settings?.review_button_label ?? "Laisser un avis");
  const [showPreview, setShowPreview] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSave() {
    startTransition(async () => {
      const result = await saveLoyaltySettings({
        enabled,
        delayDays,
        thankYouEnabled,
        subject,
        content,
        reviewEnabled,
        reviewContent,
        reviewUrl,
        reviewButtonLabel,
      });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Réglages enregistrés.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex justify-between">
        <span className="text-xs">Activer le suivi après séjour</span>
        <Toggle checked={enabled} onChange={setEnabled} label="Activer le suivi" />
      </div>
      <label className="text-xs">
        Délai après départ
        <input type="number" min="0" max="365" value={delayDays} onChange={(event) => setDelayDays(Number(event.target.value))} className="mt-2 h-10 w-full rounded-lg border border-border px-3" />
      </label>

      {/* Belongs to the email as a whole, not to the "Remerciement" block below — it stays the email's own subject even when thank_you_enabled=false (review-only). Kept outside both block cards for exactly that reason. */}
      <label className="text-xs">
        Objet de l&rsquo;email
        <input value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-border px-3" />
      </label>

      <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <div className="flex justify-between">
          <span className="text-xs font-semibold">Remerciement</span>
          <Toggle checked={thankYouEnabled} onChange={setThankYouEnabled} label="Envoyer un remerciement" />
        </div>
        <label className="text-xs">
          Message
          <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={5} className="mt-2 w-full rounded-lg border border-border p-3" />
        </label>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <div className="flex justify-between">
          <span className="text-xs font-semibold">Demande d&rsquo;avis</span>
          <Toggle checked={reviewEnabled} onChange={setReviewEnabled} label="Demander un avis" />
        </div>
        <label className="text-xs">
          Texte
          <textarea value={reviewContent} onChange={(event) => setReviewContent(event.target.value)} rows={3} className="mt-2 w-full rounded-lg border border-border p-3" />
        </label>
        <label className="text-xs">
          Lien d&rsquo;avis
          <input
            value={reviewUrl}
            onChange={(event) => setReviewUrl(event.target.value)}
            placeholder="https://…"
            className="mt-2 h-10 w-full rounded-lg border border-border px-3"
          />
        </label>
        <label className="text-xs">
          Libellé du bouton
          <input value={reviewButtonLabel} onChange={(event) => setReviewButtonLabel(event.target.value)} className="mt-2 h-10 w-full rounded-lg border border-border px-3" />
        </label>
      </div>

      <p className="text-2xs text-body">Canal V1 : email.</p>

      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => setShowPreview((value) => !value)}>
          {showPreview ? "Masquer l'aperçu" : "Aperçu"}
        </Button>
        <Button disabled={pending} onClick={handleSave}>
          {pending ? "Enregistrement…" : "Enregistrer"}
        </Button>
      </div>

      {/* Plain text/JSX rendering only — never dangerouslySetInnerHTML with hotelier-controlled content. This mirrors exactly what the worker composes (features/loyalty/worker.ts::buildPostStayMessage), never a separate re-implementation. */}
      {showPreview && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-canvas p-4">
          <p className="text-2xs uppercase text-body">Aperçu</p>
          <h3 className="text-sm font-semibold">{subject}</h3>
          {thankYouEnabled && <p className="whitespace-pre-wrap text-xs">{content}</p>}
          {reviewEnabled && (
            <div className="flex flex-col gap-2">
              <p className="whitespace-pre-wrap text-xs">{reviewContent}</p>
              {/* No fallback label here: the server requires a non-empty review_button_label (min 1 char) whenever review is enabled, so a blank field here is a real validation error the save will reject — the preview must show that, not paper over it with a default that won't actually be saved. */}
              {reviewUrl && reviewButtonLabel.trim() && (
                <span className="inline-block w-fit rounded-lg bg-ink px-4 py-2 text-xs text-canvas">{reviewButtonLabel}</span>
              )}
              {reviewUrl && !reviewButtonLabel.trim() && <p className="text-xs text-danger">Indiquez un libellé de bouton.</p>}
            </div>
          )}
          {!thankYouEnabled && !reviewEnabled && <p className="text-xs text-danger">Activez au moins un bloc pour produire un message.</p>}
        </div>
      )}
    </div>
  );
}
