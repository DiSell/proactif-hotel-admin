import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { computeStalenessBannerState } from "./StalenessBanner";
import { VOLATILE_STALENESS_DAYS } from "@/features/rag/staleness";
import type { KnowledgeSource } from "@/types/database";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "StalenessBanner.tsx"), "utf8");

const NOW = new Date("2026-08-29T12:00:00.000Z");

function daysAgoIso(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeSource(overrides: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: crypto.randomUUID(),
    hotel_id: "hotel-a",
    type: "url",
    title: "Page",
    content: "…",
    source_url: "https://example.com",
    storage_path: null,
    file_size_bytes: null,
    mime_type: null,
    status: "indexed",
    is_active: true,
    last_synced_at: daysAgoIso(1),
    created_at: daysAgoIso(1),
    updated_at: daysAgoIso(1),
    ...overrides,
  };
}

/**
 * Real-invocation tests against the pure computeStalenessBannerState() —
 * covers every scenario from the RAG freshness MVP spec exactly, which a
 * source-level regex guard alone cannot verify (this repo has no jsdom, so
 * these are unit tests on the extracted pure function, not a render test —
 * see computeStalenessBannerState's own doc comment).
 */
describe("computeStalenessBannerState", () => {
  it("[0 usable] no active+indexed source -> empty, no stale computation needed", () => {
    const state = computeStalenessBannerState([makeSource({ is_active: false })], NOW);
    expect(state.usable).toHaveLength(0);
    expect(state.hasStale).toBe(false);
    expect(state.staleSources).toHaveLength(0);
  });

  it("[a pending/error source never counts as usable] status !== 'indexed' is excluded even if is_active", () => {
    const state = computeStalenessBannerState([makeSource({ status: "pending" }), makeSource({ status: "error" })], NOW);
    expect(state.usable).toHaveLength(0);
  });

  it("[3 recent sources] no warning", () => {
    const state = computeStalenessBannerState(
      [makeSource({ last_synced_at: daysAgoIso(1) }), makeSource({ last_synced_at: daysAgoIso(2) }), makeSource({ last_synced_at: daysAgoIso(3) })],
      NOW
    );
    expect(state.hasStale).toBe(false);
    expect(state.staleSources).toHaveLength(0);
  });

  it("[2 recent + 1 twenty-day-old source] warning fires — the recent MAX must never mask the old one", () => {
    const oldSource = makeSource({ last_synced_at: daysAgoIso(20) });
    const state = computeStalenessBannerState(
      [makeSource({ last_synced_at: daysAgoIso(1) }), makeSource({ last_synced_at: daysAgoIso(2) }), oldSource],
      NOW
    );
    expect(state.hasStale).toBe(true);
    expect(state.staleSources).toHaveLength(1);
    expect(state.staleSources[0]).toBe(oldSource);
    // Display still reflects the MOST recent sync, not the stale one.
    expect(state.lastAnalyzedLabel).toBe("il y a 1 j");
  });

  it("[1 recent + 1 never-synced] warning fires — last_synced_at === null is 'à vérifier', folded into staleSources", () => {
    const neverSynced = makeSource({ last_synced_at: null });
    const state = computeStalenessBannerState([makeSource({ last_synced_at: daysAgoIso(1) }), neverSynced], NOW);
    expect(state.hasStale).toBe(true);
    expect(state.staleSources).toHaveLength(1);
    expect(state.staleSources[0]).toBe(neverSynced);
  });

  it("[exactly 7 days] not stale — threshold is strictly '> 7 days', unchanged from isStale()", () => {
    const state = computeStalenessBannerState([makeSource({ last_synced_at: daysAgoIso(VOLATILE_STALENESS_DAYS) })], NOW);
    expect(state.hasStale).toBe(false);
  });

  it("[8 days] stale", () => {
    const state = computeStalenessBannerState([makeSource({ last_synced_at: daysAgoIso(VOLATILE_STALENESS_DAYS + 1) })], NOW);
    expect(state.hasStale).toBe(true);
    expect(state.staleSources).toHaveLength(1);
  });

  it("[MAX is display-only] a recent MAX does not suppress the warning when an older source exists — the exact bug this fix addresses", () => {
    const state = computeStalenessBannerState([makeSource({ last_synced_at: daysAgoIso(0) }), makeSource({ last_synced_at: daysAgoIso(30) })], NOW);
    expect(state.lastAnalyzedLabel).toBe("aujourd’hui");
    expect(state.hasStale).toBe(true);
  });

  it("[lastSyncedAt for display ignores null entries] a never-synced source never wins the MAX over a real date", () => {
    const state = computeStalenessBannerState([makeSource({ last_synced_at: daysAgoIso(5) }), makeSource({ last_synced_at: null })], NOW);
    expect(state.lastSyncedAt).toBe(daysAgoIso(5));
  });

  it("[all usable sources never-synced] lastAnalyzedLabel is '—', never a fabricated date, but staleness still fires", () => {
    const state = computeStalenessBannerState([makeSource({ last_synced_at: null })], NOW);
    expect(state.lastAnalyzedLabel).toBe("—");
    expect(state.hasStale).toBe(true);
    expect(state.staleSources).toHaveLength(1);
  });
});

describe("StalenessBanner — wiring", () => {
  it("[reuses existing flow] the CTA renders AnalyzeSiteModal — no new crawler, no new modal", () => {
    expect(source).toMatch(/import \{ AnalyzeSiteModal \} from ".\/AnalyzeSiteModal";/);
    expect(source).toMatch(/<AnalyzeSiteModal hotelId=\{hotelId\} websiteUrl=\{websiteUrl\} onClose=\{\(\) => setAnalyzing\(false\)\} \/>/);
  });

  it("[no auto-launch] analysis only ever starts from a click, never on mount", () => {
    expect(source).not.toMatch(/useEffect/);
  });

  it("[shared threshold] imports isStale/daysSince from the same staleness module the prompt rule uses — the two can never silently diverge", () => {
    expect(source).toMatch(/import \{ daysSince, isStale \} from "@\/features\/rag\/staleness";/);
  });
});
