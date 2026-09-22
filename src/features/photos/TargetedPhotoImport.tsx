"use client";

import { useState, useTransition } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import type { ActionResult } from "@/lib/actionResult";
import type { SaveAccommodationTypesResult } from "@/features/knowledge/actions";
import { targetedImportSummary, targetedImportTotal } from "./targetedImportPlan";

interface TargetedPhotoImportProps {
  hotelId: string;
  action: (hotelId: string) => Promise<ActionResult<SaveAccommodationTypesResult>>;
}

/**
 * PHOTOS / CARROUSEL chantier — deliberately NOT rendered for any hotel
 * other than the one this plan targets (see the page that mounts this
 * component: it only does so when hotel.id matches LE_1837_HOTEL_ID). A
 * purely presentational trigger: nothing executes on mount, nothing
 * executes without two explicit clicks — an in-page arm/confirm toggle
 * (isArmed), never a native confirmation dialog: that kind of dialog can be
 * silently suppressed by the browser (repeated-dialog blocking, embedded/
 * webview contexts with no dialog support) with zero visible feedback,
 * which is exactly what made this button appear completely inert. The
 * two-click state lives entirely in this component — no new shared
 * component, no modal.
 *
 * Never claims a blanket "Import réussi" — photosFailed/photosSkippedDuplicate
 * are surfaced exactly as returned by saveAccommodationTypes (via
 * importTargetedRoomPhotos), so a partial outcome is never hidden behind a
 * green success message.
 */
export function TargetedPhotoImport({ hotelId, action }: TargetedPhotoImportProps) {
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [isArmed, setIsArmed] = useState(false);
  const [result, setResult] = useState<SaveAccommodationTypesResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const summary = targetedImportSummary();
  const total = targetedImportTotal();

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
        <h3 className="text-sm font-semibold text-ink">Import ciblé — photos officielles (chantier PHOTOS / CARROUSEL)</h3>
        <p className="mt-1 text-xs text-body">
          Importe les photos déjà identifiées et vérifiées (inspection réelle des pages officielles) pour les 7 catégories ci-dessous. Ne
          déclenche rien tant que vous n&rsquo;avez pas cliqué deux fois sur le bouton.
        </p>
      </div>

      <table className="w-full text-xs">
        <tbody>
          {summary.map((row) => (
            <tr key={row.name} className="border-b border-border/60 last:border-0">
              <td className="py-1 text-body">{row.name}</td>
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
          Import des {total} photos pour les 7 catégories concernées — cette action ne peut pas être annulée automatiquement. Cliquez à nouveau sur
          le bouton pour lancer l&rsquo;import.
        </p>
      )}

      {errorMessage && <p className="text-xs text-danger">{errorMessage}</p>}

      {result && (
        <div className="rounded-lg border border-border bg-canvas p-3 text-xs">
          <p className="font-medium text-ink">Résultat</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-body">
            <li>Hébergements mis à jour : {result.accommodationTypesUpdated}</li>
            <li>Hébergements créés : {result.accommodationTypesCreated}</li>
            <li>Photos importées : {result.photosImported}</li>
            <li>Photos déjà présentes (ignorées) : {result.photosSkippedDuplicate}</li>
            <li className={result.photosFailed > 0 ? "font-semibold text-danger" : undefined}>Photos en échec : {result.photosFailed}</li>
          </ul>
          {result.photosFailed > 0 && (
            <p className="mt-2 text-danger">
              Import partiel — {result.photosFailed} photo(s) n&rsquo;ont pas pu être importées. Consultez les logs serveur pour le détail par URL.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
