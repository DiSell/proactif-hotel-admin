"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import type { ActionResult } from "@/lib/actionResult";
import { targetedHotelMediaImportSummary, targetedHotelMediaImportTotal } from "./targetedImportPlan";
import type { ImportTargetedHotelMediaResult } from "./targetedImport";
import { HOTEL_MEDIA_CATEGORY_LABEL } from "./schema";

interface TargetedHotelMediaImportProps {
  hotelId: string;
  action: (hotelId: string) => Promise<ActionResult<ImportTargetedHotelMediaResult>>;
}

/**
 * hotel_media equivalent of features/photos/TargetedPhotoImport.tsx — same
 * two-click in-page arm/confirm UX (never a native confirmation dialog,
 * see that component's own doc comment for why), same "nothing executes on
 * mount" guarantee, same refusal to present a partial outcome as a blanket
 * success. Deliberately NOT rendered for any hotel other than the one the
 * plan targets — see the page that mounts this component.
 */
export function TargetedHotelMediaImport({ hotelId, action }: TargetedHotelMediaImportProps) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [isArmed, setIsArmed] = useState(false);
  const [result, setResult] = useState<ImportTargetedHotelMediaResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const summary = targetedHotelMediaImportSummary();
  const total = targetedHotelMediaImportTotal();

  function handleImportClick() {
    if (!isArmed) {
      setIsArmed(true);
      return;
    }

    setIsArmed(false);
    setErrorMessage(null);
    startTransition(async () => {
      const outcome = await action(hotelId);
      if (!outcome.ok) {
        setResult(null);
        setErrorMessage(outcome.error ?? "L'import a échoué.");
        toast.show(outcome.error ?? "L'import a échoué.", "danger");
        return;
      }
      setResult(outcome.data ?? null);
      const data = outcome.data;
      if (data && data.photosFailed > 0) {
        toast.show(`Import partiel : ${data.photosFailed} photo(s) en échec — voir le détail ci-dessous.`, "danger");
      } else {
        toast.show("Import terminé.", "success");
      }
    });
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h3 className="text-sm font-semibold text-ink">Import ciblé — photos d’établissement officielles</h3>
        <p className="mt-1 text-xs text-body">
          Importe les photos déjà identifiées et vérifiées pour les catégories ci-dessous. Ne déclenche rien tant que vous n&rsquo;avez pas
          cliqué deux fois sur le bouton.
        </p>
      </div>

      <table className="w-full text-xs">
        <tbody>
          {summary.map((row) => (
            <tr key={row.category} className="border-b border-border/60 last:border-0">
              <td className="py-1 text-body">{HOTEL_MEDIA_CATEGORY_LABEL[row.category]}</td>
              <td className="py-1 text-right font-medium text-ink">{row.count}</td>
            </tr>
          ))}
          <tr>
            <td className="pt-2 font-semibold text-ink">Total</td>
            <td className="pt-2 text-right font-semibold text-ink">{total}</td>
          </tr>
        </tbody>
      </table>

      <Button type="button" variant="primary" onClick={handleImportClick} disabled={isPending}>
        {isPending ? "Import en cours…" : isArmed ? `Confirmer l'import des ${total} photos` : `Importer les ${total} photos`}
      </Button>

      {isArmed && !isPending && (
        <p className="text-xs text-body">
          Import des {total} photos — cette action ne peut pas être annulée automatiquement. Cliquez à nouveau sur le bouton pour lancer
          l&rsquo;import.
        </p>
      )}

      {errorMessage && <p className="text-xs text-danger">{errorMessage}</p>}

      {result && (
        <div className="rounded-lg border border-border bg-canvas p-3 text-xs">
          <p className="font-medium text-ink">Résultat</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-body">
            <li>Photos importées : {result.photosImported}</li>
            <li>Photos déjà présentes (ignorées) : {result.photosSkippedDuplicate}</li>
            <li className={result.photosFailed > 0 ? "font-semibold text-danger" : undefined}>Photos en échec : {result.photosFailed}</li>
          </ul>
          {result.photosFailed > 0 && (
            <p className="mt-2 text-danger">
              Import partiel — {result.photosFailed} photo(s) n&rsquo;ont pas pu être importées. Consultez les logs serveur pour le détail par
              URL.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
