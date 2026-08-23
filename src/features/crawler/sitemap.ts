import * as cheerio from "cheerio";
import { MAX_CANDIDATE_URLS } from "./config";
import { safeFetch } from "./networkGuard";

/** Sitemap index files fetched per analysis — small, since a hotel site is never a multi-sitemap giant. */
const MAX_SITEMAP_FETCHES = 5;

export interface SitemapDiscoveryResult {
  urls: string[];
  /** Best-effort href -> two-letter language, read from <xhtml:link rel="alternate" hreflang="…"> entries when a sitemap includes them. Most sitemaps don't; an empty map is normal. */
  hreflangByUrl: Record<string, string>;
}

/**
 * Fetches and parses one or more sitemap URLs, following sitemap-index
 * nesting (a <sitemapindex> pointing at other sitemaps) up to
 * MAX_SITEMAP_FETCHES total requests, and returns every page URL found in
 * any <urlset>, up to MAX_CANDIDATE_URLS — this only inspects the address
 * space, it never downloads any of these pages. A sitemap that fails to
 * fetch or parse is skipped, never treated as a fatal error.
 */
export async function discoverUrlsFromSitemaps(sitemapUrls: string[]): Promise<SitemapDiscoveryResult> {
  const discovered: string[] = [];
  const hreflangByUrl: Record<string, string> = {};
  const toVisit = [...sitemapUrls];
  let fetched = 0;

  while (toVisit.length > 0 && fetched < MAX_SITEMAP_FETCHES && discovered.length < MAX_CANDIDATE_URLS) {
    const url = toVisit.shift();
    if (!url) break;
    fetched++;

    const result = await safeFetch(url);
    if (!result.ok || !result.body) continue;

    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(result.body, { xmlMode: true });
    } catch {
      continue;
    }

    const nestedSitemaps = $("sitemapindex > sitemap > loc")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    if (nestedSitemaps.length > 0) {
      toVisit.push(...nestedSitemaps);
      continue;
    }

    $("urlset > url").each((_, urlEl) => {
      if (discovered.length >= MAX_CANDIDATE_URLS) return;

      const loc = $(urlEl).find("> loc").first().text().trim();
      if (loc) discovered.push(loc);

      // Namespace-agnostic on purpose: real sitemaps tag this <xhtml:link>,
      // but xmlMode parsing doesn't resolve namespaces, so matching on the
      // attribute alone (not a specific tag name) is what actually works.
      $(urlEl)
        .find("[rel='alternate']")
        .each((_, linkEl) => {
          const href = $(linkEl).attr("href")?.trim();
          const hreflang = $(linkEl).attr("hreflang")?.trim();
          if (href && hreflang) hreflangByUrl[href] = hreflang.split("-")[0].toLowerCase();
        });
    });
  }

  return { urls: discovered, hreflangByUrl };
}

/** Convenience wrapper: tries the conventional /sitemap.xml location for a site. */
export async function tryDefaultSitemap(websiteUrl: string): Promise<SitemapDiscoveryResult> {
  let sitemapUrl: string;
  try {
    sitemapUrl = new URL("/sitemap.xml", websiteUrl).toString();
  } catch {
    return { urls: [], hreflangByUrl: {} };
  }
  return discoverUrlsFromSitemaps([sitemapUrl]);
}
