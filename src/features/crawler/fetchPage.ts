import { safeFetch, type SafeFetchErrorReason } from "./networkGuard";
import { extractPage } from "./extract";
import { normalizeUrl } from "./urlPolicy";

export type FetchPageErrorReason = SafeFetchErrorReason | "not_html" | "insufficient_content";

export type FetchPageResult =
  | { ok: true; finalUrl: string; title: string; content: string; language: string | null }
  | { ok: false; errorReason: FetchPageErrorReason; errorMessage: string };

/**
 * AJOUTER UNE URL chantier — the single-URL counterpart to crawl.ts's own
 * processUrl: fetch one page via the SAME network protections (safeFetch,
 * unchanged) and extract its real content via the SAME extraction logic
 * (extractPage, unchanged), for a caller that already knows exactly which
 * URL it wants (no link-following, no relevance scoring, no crawl budget —
 * those are crawlWebsite's own concerns, deliberately not duplicated here).
 *
 * Never fabricates content: an unreachable page, a non-HTML response, or a
 * likely-JS-rendered/empty extraction all resolve to `ok: false` — the
 * caller decides what to do (addUrlSource: never create a source at all;
 * reindexSource: mark the existing source "error" without touching its
 * previous content).
 */
export async function fetchPageContent(url: string, hotelLanguages: string[]): Promise<FetchPageResult> {
  const fetched = await safeFetch(url);
  if (!fetched.ok || !fetched.body) {
    return { ok: false, errorReason: fetched.errorReason ?? "network_error", errorMessage: fetched.errorMessage ?? "Page inaccessible." };
  }
  if (fetched.contentType && !fetched.contentType.includes("html")) {
    return { ok: false, errorReason: "not_html", errorMessage: "Cette URL ne pointe pas vers une page HTML." };
  }

  // Normalized here, same as crawl.ts's own processUrl — the caller uses
  // this as the page's identity (knowledge_sources.source_url), never the
  // raw, possibly-un-normalized requested url.
  const finalUrl = normalizeUrl(fetched.finalUrl ?? url) ?? (fetched.finalUrl ?? url);
  const extracted = extractPage(fetched.body, finalUrl, hotelLanguages);

  if (extracted.likelyJsRendered || extracted.text.length === 0) {
    return { ok: false, errorReason: "insufficient_content", errorMessage: "Contenu insuffisant — rendu JavaScript probable." };
  }

  return { ok: true, finalUrl, title: extracted.title, content: extracted.text, language: extracted.detectedLanguage };
}
