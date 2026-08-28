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
import { classifyAccommodationPage } from "@/features/crawler/accommodationPage";
import { buildAccommodationGroups, buildAccommodationTypesPayload } from "./accommodationGrouping";

type CrawlPage = AnalyzeSiteResponse["pages"][number];

const STATUS_LABEL: Record<CrawlPage["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  relevant: { label: "Pertinente", tone: "success" },
  probably_technical: { label: "Probablement technique", tone: "warning" },
  unreachable: { label: "Inaccessible", tone: "danger" },
  robots_disallowed: { label: "Interdite (robots.txt)", tone: "neutral" },
  insufficient_content: { label: "Contenu insuffisant", tone: "warning" },
  duplicate: { label: "Doublon", tone: "neutral" },
};

function hasImportableContent(status: string): boolean {
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
  const [expanded, setExpanded] = useState(false);
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

  // Keyed by group.key (canonical identity — see accommodationGrouping.ts's
  // canonicalGroupKey; NOT sourceUrl, since one group can now merge several
  // source pages for the same accommodation). Photo checkboxes are keyed by
  // the photo's own normalized URL (globally unique after dedup), not a
  // composite pageIndex-imageIndex.
  const [checkedPhotoKeys, setCheckedPhotoKeys] = useState<Set<string>>(new Set());
  // Whether a group is saved at all as an accommodation_type — independent
  // of checkedPhotoKeys. Proactif detects and pre-includes every group
  // automatically (seeded below, once, when groups first appear); the admin
  // only needs to act to EXCLUDE a wrongly-detected one, never to opt every
  // real accommodation in one by one. A group can stay included with zero
  // checked photos — see buildAccommodationTypesPayload.
  const [includedGroupKeys, setIncludedGroupKeys] = useState<Set<string>>(new Set());
  // Editable accommodation name per group — falls back to the group's own
  // suggestedName (page title / heading / nearbyHeading) until edited.
  const [groupNames, setGroupNames] = useState<Record<string, string>>({});
  // Editable capacity per group. Never pre-filled with a value the admin
  // didn't see land in the field — see togglePhoto, which seeds it once,
  // from the page's own guessedCapacity suggestion, only at the moment the
  // FIRST photo in that group is checked.
  const [groupCapacities, setGroupCapacities] = useState<Record<string, string>>({});
  const [isSavingAccommodations, startSavingAccommodations] = useTransition();

  const selectableCount = useMemo(() => pages.filter((p) => hasImportableContent(p.status)).length, [pages]);

  // The actual fix for both the "413 photos" bug AND "1 page = 1
  // accommodation_type": only pages classifyAccommodationPage judges
  // "detail" ever produce a group — "listing" (pricing/category/overview)
  // and "not_accommodation" (blog, spa, restaurant, gallery, author,
  // legal, nearby-attractions, editorial/business-for-sale pages...) never
  // do, even when they have images, and two "detail" pages for the SAME
  // accommodation are merged into one group — see accommodationGrouping.ts's
  // own doc comments. This has NO effect on hasImportableContent/handleImport
  // above: the general RAG page table and import still consider every
  // relevant/probably_technical page, unchanged — a "listing" page stays
  // fully importable as a knowledge_source.
  const accommodationGroups = useMemo(
    () => buildAccommodationGroups(pages, { isImportable: hasImportableContent, classifyAccommodationPage }),
    [pages]
  );

  const totalPhotosShown = useMemo(() => accommodationGroups.reduce((sum, g) => sum + g.photos.length, 0), [accommodationGroups]);

  function toggleGroupIncluded(group: (typeof accommodationGroups)[number]) {
    setIncludedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(group.key)) next.delete(group.key);
      else next.add(group.key);
      return next;
    });
  }

  function togglePhoto(group: (typeof accommodationGroups)[number], photoKey: string) {
    const willCheck = !checkedPhotoKeys.has(photoKey);
    setCheckedPhotoKeys((current) => {
      const next = new Set(current);
      if (willCheck) next.add(photoKey);
      else next.delete(photoKey);
      return next;
    });

    // Seed the group's capacity suggestion ONCE, only when checking a photo
    // (never when unchecking), and never overwrite a value already present.
    if (willCheck && group.suggestedCapacity !== null) {
      setGroupCapacities((current) => (group.key in current ? current : { ...current, [group.key]: String(group.suggestedCapacity) }));
    }
  }

  // The two explicit, distinct actions per accommodation the product spec
  // calls for ("Tout sélectionner" / "Tout désélectionner"), on top of
  // individual photo clicks (togglePhoto above) — never a single ambiguous
  // toggle standing in for both.
  function selectAllPhotos(group: (typeof accommodationGroups)[number]) {
    setCheckedPhotoKeys((current) => {
      const next = new Set(current);
      for (const photo of group.photos) next.add(photo.key);
      return next;
    });
    if (group.suggestedCapacity !== null) {
      setGroupCapacities((current) => (group.key in current ? current : { ...current, [group.key]: String(group.suggestedCapacity) }));
    }
  }

  function deselectAllPhotos(group: (typeof accommodationGroups)[number]) {
    setCheckedPhotoKeys((current) => {
      const next = new Set(current);
      for (const photo of group.photos) next.delete(photo.key);
      return next;
    });
  }

  const confirmedAccommodations = useMemo(
    () =>
      buildAccommodationTypesPayload(accommodationGroups, {
        includedGroupKeys,
        checkedPhotoKeys,
        names: groupNames,
        capacities: groupCapacities,
      }),
    [accommodationGroups, includedGroupKeys, checkedPhotoKeys, groupNames, groupCapacities]
  );

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

      // "Proactif détecte et prépare automatiquement" — every group detected
      // in THIS analysis starts included, with every one of its distinct
      // photos already checked (item 1: show ALL distinct photos, never a
      // pre-chosen "best few"). The admin's job is then only to EXCLUDE a
      // wrongly-detected group or DESELECT a photo they don't want — never
      // to opt real accommodations in one by one. Computed directly from
      // body.pages (not the accommodationGroups memo, which hasn't
      // re-rendered yet) right here in the event handler that produced this
      // data — never a useEffect reacting to it after the fact. A full
      // replace (not a merge with prior state) is correct: "← Nouvelle
      // analyse" always starts a fresh crawl result, never appends to the
      // previous one.
      const freshGroups = buildAccommodationGroups(body.pages, { isImportable: hasImportableContent, classifyAccommodationPage });
      setIncludedGroupKeys(new Set(freshGroups.map((group) => group.key)));
      setCheckedPhotoKeys(new Set(freshGroups.flatMap((group) => group.photos.map((photo) => photo.key))));

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
    if (confirmedAccommodations.length === 0) return;

    startSavingAccommodations(async () => {
      const accommodationTypes = confirmedAccommodations.map(({ sourceUrl, name, maxGuests, photos }) => ({
        name,
        sourceUrl,
        maxGuests,
        photos,
      }));

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
      <Card
        className={`flex w-full flex-col p-6 transition-[max-width,max-height] ${
          expanded ? "max-h-[95vh] max-w-6xl" : "max-h-[85vh] max-w-3xl"
        }`}
      >
        <div className="mb-4 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Analyser le site web</h2>
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            className="shrink-0 rounded-md p-1.5 text-body/60 hover:bg-canvas hover:text-ink"
            aria-label={expanded ? "Réduire la fenêtre" : "Agrandir la fenêtre"}
            title={expanded ? "Réduire" : "Agrandir"}
          >
            {expanded ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 9V4h5M15 4h5v5M4 15v5h5M15 20h5v-5" />
              </svg>
            )}
          </button>
        </div>

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

            {accommodationGroups.length > 0 && (
              <div className={`flex flex-col gap-2 rounded-lg border border-border p-3 ${expanded ? "max-h-[60vh]" : "max-h-80"}`}>
                <p className="text-2xs font-medium text-ink">
                  Hébergements détectés ({accommodationGroups.length}, {totalPhotosShown} photo(s) au total — aucune
                  photo n’est écartée automatiquement) — seules les pages identifiées comme la fiche d’un hébergement
                  précis alimentent cette liste (les pages de tarifs/catégories restent disponibles pour la base de
                  connaissances, mais jamais comme hébergement). Chaque hébergement détecté est inclus par défaut ;
                  décochez-le pour l’exclure. Le choix des photos affichées dans le chatbot reste modifiable ensuite
                  par le client depuis son portail. Une capacité suggérée n’est jamais enregistrée sans confirmation ;
                  laissez le champ vide si elle n’est pas fiable.
                </p>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
                  {accommodationGroups.map((group) => {
                    const name = groupNames[group.key] ?? group.suggestedName;
                    const capacity = groupCapacities[group.key] ?? "";
                    const included = includedGroupKeys.has(group.key);
                    const checkedInGroup = group.photos.filter((photo) => checkedPhotoKeys.has(photo.key)).length;
                    const allChecked = group.photos.length > 0 && checkedInGroup === group.photos.length;
                    const noneChecked = checkedInGroup === 0;
                    return (
                      <div
                        key={group.key}
                        className={`flex flex-col gap-2 rounded-lg border p-2.5 ${included ? "border-ink/40 bg-canvas" : "border-border/70 opacity-60"}`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={() => toggleGroupIncluded(group)}
                            className="h-4 w-4 shrink-0 accent-ink"
                            aria-label={`Inclure l’hébergement ${name || "sans nom"} (${group.photos.length} photo(s) détectée(s))`}
                          />
                          <input
                            value={name}
                            onChange={(event) => setGroupNames((current) => ({ ...current, [group.key]: event.target.value }))}
                            placeholder="Nom de l’hébergement (ex. Junior Suite)"
                            className={`${inputClassName()} min-w-40 flex-1`}
                          />
                          <input
                            type="number"
                            min={1}
                            value={capacity}
                            onChange={(event) => setGroupCapacities((current) => ({ ...current, [group.key]: event.target.value }))}
                            placeholder="Capacité inconnue"
                            className={`${inputClassName()} w-32`}
                          />
                          <span className="shrink-0 text-2xs text-body/60">
                            {checkedInGroup}/{group.photos.length} photo(s) sélectionnée(s)
                          </span>
                        </div>
                        <p className="truncate text-2xs text-body/50">
                          {group.mergedSourceUrls.length > 1
                            ? `regroupé depuis ${group.mergedSourceUrls.length} pages : ${group.mergedSourceUrls.join(", ")}`
                            : `source : ${group.sourceUrl}`}
                        </p>
                        {group.photos.length > 0 && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => selectAllPhotos(group)}
                              disabled={allChecked}
                              className="rounded-md border border-border px-2 py-1 text-2xs font-medium text-ink hover:bg-canvas disabled:opacity-40"
                            >
                              Tout sélectionner
                            </button>
                            <button
                              type="button"
                              onClick={() => deselectAllPhotos(group)}
                              disabled={noneChecked}
                              className="rounded-md border border-border px-2 py-1 text-2xs font-medium text-ink hover:bg-canvas disabled:opacity-40"
                            >
                              Tout désélectionner
                            </button>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-2">
                          {group.photos.map((photo) => {
                            const checked = checkedPhotoKeys.has(photo.key);
                            return (
                              <label key={photo.key} className="relative cursor-pointer" title={photo.alt ?? undefined}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => togglePhoto(group, photo.key)}
                                  className="sr-only"
                                  aria-label={`Sélectionner la photo ${photo.alt ?? ""}`}
                                />
                                {/* eslint-disable-next-line @next/next/no-img-element -- crawled site's own image URL, previewed before any download/upload; the raw URL itself is never shown as text (see AnalyzeSiteModal fix), only the thumbnail and the group's own name/source. */}
                                <img
                                  src={photo.url}
                                  alt={photo.alt ?? ""}
                                  className={`h-14 w-20 rounded object-cover ${checked ? "ring-2 ring-ink" : "opacity-70 hover:opacity-100"}`}
                                />
                                {checked && (
                                  <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-ink text-canvas">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M20 6L9 17l-5-5" />
                                    </svg>
                                  </span>
                                )}
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-end">
                  <Button
                    variant="ghost"
                    onClick={handleSaveAccommodations}
                    disabled={isSavingAccommodations || confirmedAccommodations.length === 0}
                  >
                    {isSavingAccommodations ? "Enregistrement…" : `Enregistrer les hébergements (${confirmedAccommodations.length})`}
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
