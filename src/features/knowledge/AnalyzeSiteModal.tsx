"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { importCrawledPages, confirmSiteAnalysisConsent, saveAccommodationTypes } from "./actions";
import { SITE_ANALYSIS_CONSENT_TEXT } from "./siteAnalysisConsent";
import type { AnalyzeSiteConsentRequiredResponse, AnalyzeSiteErrorResponse, AnalyzeSiteResponse } from "./schema";

type CrawlPage = AnalyzeSiteResponse["pages"][number];

const STATUS_LABEL: Record<CrawlPage["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  relevant: { label: "Pertinente", tone: "success" },
  probably_technical: { label: "Probablement technique", tone: "warning" },
  unreachable: { label: "Inaccessible", tone: "danger" },
  robots_disallowed: { label: "Interdite (robots.txt)", tone: "neutral" },
  insufficient_content: { label: "Contenu insuffisant", tone: "warning" },
  duplicate: { label: "Doublon", tone: "neutral" },
};

function hasImportableContent(status: CrawlPage["status"]): boolean {
  // Only relevant/probably_technical pages carry content worth importing.
  // duplicate/insufficient_content/unreachable/robots_disallowed must never
  // be selectable — a duplicate in particular already has a live copy
  // covered elsewhere in the crawl, and the server's own finalUrl dedup
  // (importCrawledPages) is a backstop, not a reason to let the UI offer
  // these rows as if they were importable.
  return status === "relevant" || status === "probably_technical";
}

function formatSize(chars: number): string {
  if (chars === 0) return "—";
  if (chars < 1000) return `${chars} car.`;
  return `${(chars / 1000).toFixed(1)} k car.`;
}

const STOPPED_REASON_LABEL: Record<AnalyzeSiteResponse["stoppedReason"], string> = {
  useful_page_limit: "objectif de pages utiles atteint",
  fetch_attempt_limit: "limite de tentatives atteinte",
  time_limit: "durée maximale atteinte",
  candidate_exhausted: "toutes les URLs candidates ont été traitées",
};

export function AnalyzeSiteModal({ hotelId, websiteUrl, onClose }: { hotelId: string; websiteUrl: string; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = useState<"input" | "consent" | "results">("input");
  const [url, setUrl] = useState(websiteUrl || "");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [pendingConsentDomain, setPendingConsentDomain] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [confirmingConsent, setConfirmingConsent] = useState(false);
  const [pages, setPages] = useState<CrawlPage[]>([]);
  const [sitemapUsed, setSitemapUsed] = useState(false);
  const [stats, setStats] = useState<{
    totalCandidateUrls: number;
    processedPages: number;
    usefulPages: number;
    fetchAttempts: number;
    skippedBecausePageLimit: number;
    countsByDetectedLanguage: Record<string, number>;
    stoppedReason: AnalyzeSiteResponse["stoppedReason"];
  } | null>(null);
  // Indexed by row position, not finalUrl — two distinct requestedUrls can
  // (rarely) redirect to the identical finalUrl, and a string key would
  // then make selecting one row also select the other.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isImporting, startImport] = useTransition();

  // Keyed by "pageIndex-imageIndex", not image URL — the same photo URL can
  // (rarely) appear on two different pages, and the room_photos content_hash
  // dedup on the server is the real backstop, not this key choice.
  const [photoState, setPhotoState] = useState<Record<string, { checked: boolean; name: string }>>({});
  // Keyed by trimmed accommodation name (as currently typed) -> capacity
  // input string. Never pre-filled with a value the admin didn't see land
  // in the field — see togglePhoto, which seeds it once, from the page's own
  // guessedCapacity suggestion, only at the moment a photo is checked.
  const [capacityByName, setCapacityByName] = useState<Record<string, string>>({});
  const [isSavingAccommodations, startSavingAccommodations] = useTransition();

  const selectableCount = useMemo(() => pages.filter((p) => hasImportableContent(p.status)).length, [pages]);

  const photoCandidates = useMemo(() => {
    const list: {
      key: string;
      url: string;
      alt: string | null;
      sourceUrl: string;
      suggestedName: string | null;
      suggestedCapacity: number | null;
    }[] = [];
    pages.forEach((page, pageIndex) => {
      if (!hasImportableContent(page.status)) return;
      page.images.forEach((image, imageIndex) => {
        list.push({
          key: `${pageIndex}-${imageIndex}`,
          url: image.url,
          alt: image.alt,
          sourceUrl: page.finalUrl,
          suggestedName: image.nearbyHeading,
          suggestedCapacity: page.guessedCapacity?.value ?? null,
        });
      });
    });
    return list;
  }, [pages]);

  function togglePhoto(key: string, suggestedName: string | null, suggestedCapacity: number | null) {
    const existing = photoState[key] ?? { checked: false, name: suggestedName ?? "" };
    const nextChecked = !existing.checked;
    setPhotoState((current) => ({ ...current, [key]: { ...existing, checked: nextChecked } }));

    // Seed a capacity suggestion for this name ONCE, only when checking a
    // photo (never when unchecking, and never overwriting a value already
    // present — an admin who already typed/cleared a capacity keeps it).
    const trimmedName = existing.name.trim();
    if (nextChecked && trimmedName && suggestedCapacity !== null) {
      setCapacityByName((current) => (trimmedName in current ? current : { ...current, [trimmedName]: String(suggestedCapacity) }));
    }
  }

  function updatePhotoName(key: string, suggestedName: string | null, name: string) {
    setPhotoState((current) => ({ ...current, [key]: { checked: current[key]?.checked ?? false, name } }));
  }

  // Grouped live from currently-checked photos + their currently-typed name
  // — this IS the accommodationTypes payload shape saveAccommodationTypes
  // expects, one entry per distinct non-empty name.
  const checkedPhotosByName = useMemo(() => {
    const map = new Map<string, typeof photoCandidates>();
    for (const candidate of photoCandidates) {
      const state = photoState[candidate.key];
      if (!state?.checked) continue;
      const name = state.name.trim();
      if (!name) continue;
      const list = map.get(name) ?? [];
      list.push(candidate);
      map.set(name, list);
    }
    return map;
  }, [photoCandidates, photoState]);

  async function handleAnalyze() {
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const response = await fetch(`/api/hotels/${hotelId}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!response.ok) {
        // Read the body exactly once — 403 covers two distinct cases
        // (consent needed vs. domain mismatch), branched on the same parse.
        const body = await response.json().catch(() => null);
        if (response.status === 403 && body?.consentRequired) {
          const consentBody = body as AnalyzeSiteConsentRequiredResponse;
          setPendingConsentDomain(consentBody.domain);
          setConsentChecked(false);
          setStep("consent");
          return;
        }
        const errorBody = body as AnalyzeSiteErrorResponse | null;
        setAnalyzeError(errorBody?.error || "L’analyse a échoué.");
        return;
      }
      const body: AnalyzeSiteResponse = await response.json();
      setPages(body.pages);
      setSitemapUsed(body.sitemapUsed);
      setStats({
        totalCandidateUrls: body.totalCandidateUrls,
        processedPages: body.processedPages,
        usefulPages: body.usefulPages,
        fetchAttempts: body.fetchAttempts,
        skippedBecausePageLimit: body.skippedBecausePageLimit,
        countsByDetectedLanguage: body.countsByDetectedLanguage,
        stoppedReason: body.stoppedReason,
      });
      setSelected(new Set(body.pages.reduce<number[]>((acc, p, i) => (p.recommended ? [...acc, i] : acc), [])));
      setStep("results");
    } catch {
      setAnalyzeError("L’analyse a échoué. Vérifiez l’URL et réessayez.");
    } finally {
      setAnalyzing(false);
    }
  }

  function handleConfirmConsent() {
    if (!pendingConsentDomain || !consentChecked) return;
    setConfirmingConsent(true);
    setAnalyzeError(null);
    (async () => {
      const result = await confirmSiteAnalysisConsent(hotelId, { domain: pendingConsentDomain });
      setConfirmingConsent(false);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setStep("input");
      await handleAnalyze();
    })();
  }

  function toggle(index: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function handleImport() {
    const selectedPages = pages.filter((p, i) => selected.has(i) && hasImportableContent(p.status));
    if (selectedPages.length === 0) return;

    startImport(async () => {
      const result = await importCrawledPages(hotelId, {
        pages: selectedPages.map((p) => ({ finalUrl: p.finalUrl, title: p.title, content: p.content, language: p.language })),
      });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      const { imported, updated, unchanged, errors } = result.data!;
      const parts = [
        imported > 0 ? `${imported} ajoutée(s)` : null,
        updated > 0 ? `${updated} mise(s) à jour` : null,
        unchanged > 0 ? `${unchanged} inchangée(s)` : null,
        errors > 0 ? `${errors} en erreur` : null,
      ].filter(Boolean);
      toast.show(parts.join(", ") || "Import terminé.", errors > 0 ? "danger" : "success");
      router.refresh();
      onClose();
    });
  }

  function handleSaveAccommodations() {
    const names = Array.from(checkedPhotosByName.keys());
    if (names.length === 0) return;

    startSavingAccommodations(async () => {
      const accommodationTypes = names.map((name) => {
        const photosForName = checkedPhotosByName.get(name)!;
        const capacityRaw = (capacityByName[name] ?? "").trim();
        const parsedCapacity = capacityRaw ? Number.parseInt(capacityRaw, 10) : null;
        // Never forced/guessed here either — an unparseable or cleared field sends null, exactly like an admin who left it blank.
        const maxGuests = parsedCapacity !== null && Number.isFinite(parsedCapacity) && parsedCapacity > 0 ? parsedCapacity : null;
        return {
          name,
          sourceUrl: photosForName[0].sourceUrl,
          maxGuests,
          photos: photosForName.map((p) => ({ imageUrl: p.url, altText: p.alt, sourceUrl: p.sourceUrl })),
        };
      });

      const result = await saveAccommodationTypes(hotelId, { accommodationTypes });
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      const { accommodationTypesCreated, accommodationTypesUpdated, photosImported, photosSkippedDuplicate, photosFailed } = result.data!;
      const parts = [
        accommodationTypesCreated > 0 ? `${accommodationTypesCreated} hébergement(s) créé(s)` : null,
        accommodationTypesUpdated > 0 ? `${accommodationTypesUpdated} mis à jour` : null,
        photosImported > 0 ? `${photosImported} photo(s) ajoutée(s)` : null,
        photosSkippedDuplicate > 0 ? `${photosSkippedDuplicate} déjà importée(s)` : null,
        photosFailed > 0 ? `${photosFailed} photo(s) en erreur` : null,
      ].filter(Boolean);
      toast.show(parts.join(", ") || "Enregistrement terminé.", photosFailed > 0 ? "danger" : "success");
      router.refresh();
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4">
      <Card className="flex max-h-[85vh] w-full max-w-3xl flex-col p-6">
        <h2 className="mb-4 text-sm font-semibold text-ink">Analyser le site web</h2>

        {step === "input" && (
          <div className="flex flex-col gap-4">
            <FormField label="URL du site" htmlFor="analyze-url" required>
              <input
                id="analyze-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.exemple-hotel.fr"
                className={inputClassName()}
              />
            </FormField>
            {analyzeError && <p className="text-xs text-danger">{analyzeError}</p>}
            <p className="text-2xs text-body/70">
              Recherche jusqu’à 30 pages utiles du domaine (en respectant robots.txt), quitte à essayer davantage d’URLs si
              certaines sont introuvables. Aucune donnée n’est enregistrée avant votre sélection à l’étape suivante.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={analyzing}>
                Annuler
              </Button>
              <Button variant="primary" onClick={handleAnalyze} disabled={analyzing || !url.trim()}>
                {analyzing ? "Analyse en cours…" : "Lancer l’analyse"}
              </Button>
            </div>
          </div>
        )}

        {step === "consent" && pendingConsentDomain && (
          <div className="flex flex-col gap-4">
            <p className="text-xs text-body">
              Avant la première analyse du domaine <span className="font-medium text-ink">{pendingConsentDomain}</span>, une
              confirmation explicite est nécessaire.
            </p>
            <label className="flex items-start gap-2 rounded-lg border border-border bg-canvas p-3 text-xs text-ink">
              <input
                type="checkbox"
                checked={consentChecked}
                onChange={(event) => setConsentChecked(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-ink"
              />
              <span>{SITE_ANALYSIS_CONSENT_TEXT}</span>
            </label>
            <p className="text-2xs text-body/60">
              Ce consentement porte uniquement sur {pendingConsentDomain}. Il ne remplace pas robots.txt : l’analyse continue
              de respecter les règles du site et les protections réseau habituelles.
            </p>
            {analyzeError && <p className="text-xs text-danger">{analyzeError}</p>}
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep("input")} disabled={confirmingConsent}>
                Retour
              </Button>
              <Button variant="primary" onClick={handleConfirmConsent} disabled={!consentChecked || confirmingConsent}>
                {confirmingConsent ? "Enregistrement…" : "Confirmer et lancer l’analyse"}
              </Button>
            </div>
          </div>
        )}

        {step === "results" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <p className="text-2xs text-body/70">
              {stats?.totalCandidateUrls ?? pages.length} URL(s) candidate(s) découverte(s)
              {sitemapUsed ? " via le plan du site (sitemap.xml)" : " par exploration des liens"}
              {stats ? ` — ${stats.fetchAttempts} tentative(s) de récupération, ${stats.usefulPages} utile(s)` : ""}
              {stats && stats.skippedBecausePageLimit > 0 ? `, ${stats.skippedBecausePageLimit} hors budget` : ""}.{" "}
              {selectableCount} sélectionnable(s).
              {stats ? ` Arrêt : ${STOPPED_REASON_LABEL[stats.stoppedReason]}.` : ""}
            </p>
            {stats && Object.keys(stats.countsByDetectedLanguage).length > 0 && (
              <p className="text-2xs text-body/60">
                Langues détectées :{" "}
                {Object.entries(stats.countsByDetectedLanguage)
                  .map(([lang, count]) => `${lang === "unknown" ? "indéterminée" : lang.toUpperCase()} (${count})`)
                  .join(", ")}
              </p>
            )}

            {pages.length === 0 ? (
              <EmptyState title="Aucune page trouvée." description="Vérifiez l’URL ou ajoutez vos sources manuellement." />
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-border text-2xs font-medium uppercase tracking-wide text-body/65">
                      <th className="w-8 px-3 py-2"></th>
                      <th className="px-3 py-2">Page</th>
                      <th className="w-16 px-3 py-2">Langue</th>
                      <th className="w-20 px-3 py-2">Taille</th>
                      <th className="w-44 px-3 py-2">Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pages.map((page, index) => {
                      const importable = hasImportableContent(page.status);
                      return (
                        <tr key={`${page.finalUrl}#${index}`} className="border-b border-border last:border-0">
                          <td className="px-3 py-2 align-top">
                            <input
                              type="checkbox"
                              checked={selected.has(index)}
                              disabled={!importable}
                              onChange={() => toggle(index)}
                              className="mt-0.5 h-4 w-4 accent-ink disabled:opacity-40"
                              aria-label={`Sélectionner ${page.title}`}
                            />
                          </td>
                          <td className="px-3 py-2 align-top">
                            <p className="font-medium text-ink">{page.title}</p>
                            <p className="truncate text-2xs text-body/60">{page.finalUrl}</p>
                            {page.canonicalUrl && page.canonicalUrl !== page.finalUrl && (
                              <p className="truncate text-2xs text-body/40" title="Canonical déclaré par la page — informatif uniquement, jamais utilisé comme identité">
                                canonical : {page.canonicalUrl}
                              </p>
                            )}
                            {page.errorMessage && <p className="text-2xs text-danger">{page.errorMessage}</p>}
                          </td>
                          <td className="px-3 py-2 align-top text-body/80">{page.language ? page.language.toUpperCase() : "—"}</td>
                          <td className="px-3 py-2 align-top text-body/80">{formatSize(page.contentLength)}</td>
                          <td className="px-3 py-2 align-top">
                            <StatusBadge label={STATUS_LABEL[page.status].label} tone={STATUS_LABEL[page.status].tone} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {photoCandidates.length > 0 && (
              <div className="flex max-h-64 flex-col gap-2 rounded-lg border border-border p-3">
                <p className="text-2xs font-medium text-ink">
                  Photos de chambres détectées ({photoCandidates.length}) — cochez celles à conserver et confirmez ou
                  corrigez le nom de l’hébergement. Une capacité suggérée n’est jamais enregistrée sans confirmation ;
                  laissez le champ vide si elle n’est pas fiable.
                </p>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <ul className="flex flex-col gap-2">
                    {photoCandidates.map((candidate) => {
                      const state = photoState[candidate.key] ?? { checked: false, name: candidate.suggestedName ?? "" };
                      return (
                        <li key={candidate.key} className="flex items-start gap-2 border-b border-border/60 pb-2 last:border-0">
                          <input
                            type="checkbox"
                            checked={state.checked}
                            onChange={() => togglePhoto(candidate.key, candidate.suggestedName, candidate.suggestedCapacity)}
                            className="mt-1 h-4 w-4 shrink-0 accent-ink"
                            aria-label={`Sélectionner la photo ${candidate.alt ?? candidate.url}`}
                          />
                          {/* eslint-disable-next-line @next/next/no-img-element -- crawled site's own image URL, previewed before any download/upload. */}
                          <img src={candidate.url} alt={candidate.alt ?? ""} className="h-12 w-16 shrink-0 rounded object-cover" />
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <input
                              value={state.name}
                              onChange={(event) => updatePhotoName(candidate.key, candidate.suggestedName, event.target.value)}
                              placeholder="Nom de l’hébergement (ex. Junior Suite)"
                              className={inputClassName()}
                            />
                            <p className="truncate text-2xs text-body/50">{candidate.sourceUrl}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                {checkedPhotosByName.size > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-border pt-2">
                    {Array.from(checkedPhotosByName.keys()).map((name) => (
                      <div key={name} className="flex items-center gap-2 text-2xs">
                        <span className="min-w-0 flex-1 truncate text-body/80">{name}</span>
                        <input
                          type="number"
                          min={1}
                          value={capacityByName[name] ?? ""}
                          onChange={(event) => setCapacityByName((current) => ({ ...current, [name]: event.target.value }))}
                          placeholder="Capacité inconnue"
                          className={`${inputClassName()} w-32`}
                        />
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    onClick={handleSaveAccommodations}
                    disabled={isSavingAccommodations || checkedPhotosByName.size === 0}
                  >
                    {isSavingAccommodations ? "Enregistrement…" : `Enregistrer les hébergements (${checkedPhotosByName.size})`}
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-2 flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={() => setStep("input")} disabled={isImporting}>
                ← Nouvelle analyse
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose} disabled={isImporting}>
                  Annuler
                </Button>
                <Button variant="primary" onClick={handleImport} disabled={isImporting || selected.size === 0}>
                  {isImporting ? "Import en cours…" : `Ajouter à la base de connaissances (${selected.size})`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
