"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { CSV_FIELDS, previewCsv, readCsv, type CsvField, type CsvMapping } from "./csv";
import { importCustomersCsv } from "./actions";

const LABELS: Record<CsvField, string> = { first_name: "Prénom", last_name: "Nom", email: "Email", phone: "Téléphone", check_in: "Arrivée", check_out: "Départ", external_reference: "Référence externe" };

export function CsvImportWizard() {
  const router = useRouter();
  const toast = useToast();
  const [csvText, setCsvText] = useState("");
  const [mapping, setMapping] = useState<CsvMapping>({});
  const [step, setStep] = useState(1);
  const [result, setResult] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const parsed = useMemo(() => readCsv(csvText), [csvText]);
  const preview = useMemo(() => previewCsv(csvText, mapping), [csvText, mapping]);

  function handleImport() {
    startTransition(async () => {
      const response = await importCustomersCsv({ csvText, mapping });
      if (!response.ok) {
        toast.show(response.error ?? "Erreur", "danger");
        return;
      }
      setResult(`${response.data!.imported} importé(s), ${response.data!.invalid} invalide(s), ${response.data!.duplicates} doublon(s).`);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-2xs uppercase tracking-wide text-body">Étape {step} sur 4</p>

      {step === 1 && (
        <>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file)
                file.text().then((text) => {
                  setCsvText(text);
                  setStep(2);
                });
            }}
            className="text-xs"
          />
          <p className="text-2xs text-body">Le fichier est uniquement lu pour préparer la correspondance. Aucun import immédiat.</p>
        </>
      )}

      {step === 2 && (
        <>
          <p className="text-xs">Associez les colonnes du fichier aux champs système.</p>
          {CSV_FIELDS.map((field) => (
            <label key={field} className="grid grid-cols-2 items-center gap-3 text-xs">
              <span>{LABELS[field]}</span>
              <select value={mapping[field] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))} className="h-9 rounded-lg border border-border px-2">
                <option value="">Non associé</option>
                {parsed.headers.map((header) => (
                  <option key={header}>{header}</option>
                ))}
              </select>
            </label>
          ))}
          <Button onClick={() => setStep(3)}>Afficher l&rsquo;aperçu</Button>
        </>
      )}

      {step === 3 && (
        <>
          <div className="max-h-64 overflow-auto text-2xs">
            {preview.slice(0, 50).map((row) => (
              <div key={row.rowNumber} className="border-b border-border py-2">
                Ligne {row.rowNumber} — {row.values.email || row.values.phone || "sans contact"}
                {row.probableDuplicate && <strong> — doublon probable</strong>}
                {row.errors.length > 0 && <span className="text-danger"> — {row.errors.join(", ")}</span>}
              </div>
            ))}
          </div>
          <p className="text-xs">
            {preview.filter((r) => !r.errors.length && !r.probableDuplicate).length} valide(s), {preview.filter((r) => r.errors.length).length} invalide(s),{" "}
            {preview.filter((r) => r.probableDuplicate).length} doublon(s) probable(s).
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep(2)}>
              Modifier
            </Button>
            <Button onClick={() => setStep(4)}>Valider</Button>
          </div>
        </>
      )}

      {step === 4 && (
        <>
          <p className="text-xs">Confirmez l&rsquo;import. Les lignes invalides et les doublons probables seront ignorés, jamais fusionnés automatiquement.</p>
          <Button disabled={pending} onClick={handleImport}>
            {pending ? "Import…" : "Importer"}
          </Button>
          {result && <p className="text-xs">{result}</p>}
        </>
      )}
    </div>
  );
}
