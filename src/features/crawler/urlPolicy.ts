import { EXCLUDED_EXTENSIONS, EXCLUDED_PATH_KEYWORDS, INFINITE_QUERY_PARAMS, MIN_CONTENT_CHARS, TRACKING_QUERY_PARAMS } from "./config";

/**
 * Canonicalizes a URL for identity/dedup purposes: strips the fragment
 * (never sent to a server, never distinguishes real content), removes
 * tracking query params, sorts the remaining ones for a stable string, and
 * drops a trailing slash (except on the root). Returns null for anything
 * that isn't a valid http(s) URL.
 */
export function normalizeUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  url.hash = "";
  for (const param of TRACKING_QUERY_PARAMS) url.searchParams.delete(param);
  url.searchParams.sort();
  url.hostname = url.hostname.toLowerCase();
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/** Resolves a possibly-relative href against the page it was found on. Returns null for anything unparseable. */
export function resolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Best-effort language guess from URL STRUCTURE ALONE — no network call, no
 * HTML. Used both to prioritize the crawl queue before downloading anything
 * (see crawl.ts) and as extract.ts's fallback when a fetched page has no
 * `<html lang>` attribute. Checks path segments (/fr/, /en/, …) then a
 * `lang`/`language` query param, both against the hotel's own configured
 * language list — never guesses a language the hotel hasn't configured.
 */
export function inferLanguageFromUrl(url: string, knownLanguages: string[]): string | null {
  if (knownLanguages.length === 0) return null;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    for (const segment of segments) {
      const lower = segment.toLowerCase();
      if (knownLanguages.includes(lower)) return lower;
    }
    for (const param of ["lang", "language"]) {
      const value = parsed.searchParams.get(param);
      if (value && knownLanguages.includes(value.toLowerCase())) return value.toLowerCase();
    }
  } catch {
    return null;
  }
  return null;
}

function bareDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * The bare domain (lowercase, "www." stripped, no scheme/path/port) a URL
 * belongs to — used both by isSameDomain and, outside this module, as the
 * consent key in knowledge/actions.ts (site analysis consent is scoped to
 * exactly this string, never a wildcard). Returns null for anything that
 * isn't a parseable http(s) URL.
 */
export function getDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return bareDomain(parsed.hostname);
  } catch {
    return null;
  }
}

/** True if both URLs are on the same domain, treating "www.x" and "x" as the same site. */
export function isSameDomain(candidateUrl: string, referenceUrl: string): boolean {
  try {
    return bareDomain(new URL(candidateUrl).hostname) === bareDomain(new URL(referenceUrl).hostname);
  } catch {
    return false;
  }
}

export interface ShouldCrawlOptions {
  websiteUrl: string;
}

/**
 * Decides whether a URL is even worth FETCHING during discovery — before
 * any network call. Same-domain only, http(s) only (this also rejects
 * mailto:/tel:/javascript: since none of those have an http(s) protocol),
 * no known asset/technical extensions, no admin/cart/search/tracking-widget
 * paths, no obviously-infinite calendar/pagination query params.
 */
export function shouldCrawlUrl(url: string, options: ShouldCrawlOptions): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!isSameDomain(url, options.websiteUrl)) return false;

  const lowerPath = parsed.pathname.toLowerCase();
  if (EXCLUDED_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) return false;

  const lowerFull = url.toLowerCase();
  if (EXCLUDED_PATH_KEYWORDS.some((keyword) => lowerFull.includes(keyword))) return false;

  for (const param of INFINITE_QUERY_PARAMS) {
    if (parsed.searchParams.has(param)) return false;
  }

  return true;
}

export type IndexDecision = "relevant" | "insufficient_content" | "duplicate";

/**
 * Decides whether an already-fetched, already-extracted page is worth
 * indexing. Called AFTER extraction, unlike shouldCrawlUrl — this is where
 * "too little real text" and "identical to a page we already kept" are
 * caught, not before the fetch.
 */
export function shouldIndexPage(params: { text: string; isDuplicate: boolean }): IndexDecision {
  if (params.isDuplicate) return "duplicate";
  if (params.text.trim().length < MIN_CONTENT_CHARS) return "insufficient_content";
  return "relevant";
}

/** Normalizes and deduplicates a list of URLs, preserving first-seen order. */
export function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
