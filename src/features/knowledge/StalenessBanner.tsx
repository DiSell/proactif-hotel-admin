"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { daysSince, isStale } from "@/features/rag/staleness";
import { AnalyzeSiteModal } from "./AnalyzeSiteModal";
import type { KnowledgeSource } from "@/types/database";

export interface StalenessBannerState {
  /** Sources the chatbot can actually use today (is_active && status === "indexed"). */
  usable: KnowledgeSource[];
  /**
   * MAX(last_synced_at) among `usable`, used ONLY to build lastAnalyzedLabel
   * below — never to decide staleness. See staleSources for that.
   */
  lastSyncedAt: string | null;
  lastAnalyzedLabel: string;
  /**
   * Every usable source that is either stale (isStale(), > VOLATILE_STALENESS_DAYS
   * old) OR has never been synced at all (last_synced_at === null, "fraîcheur
   * inconnue / à vérifier" — folded into the same list/warning as an actually
   * stale source, since both mean the same thing to an admin: "go check
   * this one"). Computed per-source — a single recently-synced source can
   * never mask another, older one.
   */
  staleSources: KnowledgeSource[];
  hasStale: boolean;
}

/**
 * Pure — no React, no Date.now() unless `now` is omitted — so every
 * scenario in the RAG freshness MVP spec (0 usable / N recent / recent+old
 * mix / recent+never-synced mix / exactly-7-days / 8-days) can be asserted
 * by real invocation in StalenessBanner.test.ts instead of only a
 * source-level regex guard.
 */
export function computeStalenessBannerState(sources: KnowledgeSource[], now?: Date): StalenessBannerState {
  const usable = sources.filter((s) => s.is_active && s.status === "indexed");

  const lastSyncedAt = usable.reduce<string | null>((latest, s) => {
    if (!s.last_synced_at) return latest;
    return !latest || s.last_synced_at > latest ? s.last_synced_at : latest;
  }, null);
  const elapsedDays = daysSince(lastSyncedAt, now);
  const lastAnalyzedLabel = elapsedDays === null ? "—" : elapsedDays === 0 ? "aujourd’hui" : `il y a ${elapsedDays} j`;

  const staleSources = usable.filter((s) => s.last_synced_at === null || isStale(s.last_synced_at, undefined, now));

  return { usable, lastSyncedAt, lastAnalyzedLabel, staleSources, hasStale: staleSources.length > 0 };
}

/**
 * Operational visibility only — RAG freshness MVP (see 0016_rag_freshness.sql
 * and features/rag/prompt.ts's own freshness rule, which uses the same
 * threshold via features/rag/staleness.ts). Never launches a crawl itself:
 * the "Analyser le site" button here opens the exact same AnalyzeSiteModal
 * AddSourceMenu already uses — no second crawler, no automatic trigger.
 */
export function StalenessBanner({ hotelId, websiteUrl, sources }: { hotelId: string; websiteUrl: string; sources: KnowledgeSource[] }) {
  const [analyzing, setAnalyzing] = useState(false);
  const { usable, lastAnalyzedLabel, staleSources, hasStale } = computeStalenessBannerState(sources);

  if (usable.length === 0) {
    return (
      <>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
          <div className="flex flex-col gap-1">
            <StatusBadge label="Base de connaissances vide" tone="danger" />
            <p className="text-xs text-body">L’assistant ne dispose d’aucune connaissance indexée pour cet établissement.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setAnalyzing(true)}>
            Analyser le site
          </Button>
        </div>
        {analyzing && <AnalyzeSiteModal hotelId={hotelId} websiteUrl={websiteUrl} onClose={() => setAnalyzing(false)} />}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-body">Dernière analyse : {lastAnalyzedLabel}</p>
          {hasStale && (
            <p className="text-xs font-medium" style={{ color: "var(--color-warning)" }}>
              Les informations de cet établissement peuvent être obsolètes. {staleSources.length} source{staleSources.length > 1 ? "s" : ""} à
              vérifier.
            </p>
          )}
        </div>
        {hasStale && (
          <Button variant="secondary" size="sm" onClick={() => setAnalyzing(true)}>
            Analyser le site
          </Button>
        )}
      </div>
      {analyzing && <AnalyzeSiteModal hotelId={hotelId} websiteUrl={websiteUrl} onClose={() => setAnalyzing(false)} />}
    </>
  );
}
