import { CRAWL_CONCURRENCY, MAX_CANDIDATE_URLS, MAX_CRAWL_DURATION_MS, MAX_DEPTH, MAX_FETCH_ATTEMPTS, MAX_USEFUL_PAGES, REQUEST_DELAY_MS, USER_AGENT } from "./config";
import { extractLinks, extractPage, type ExtractedImage, type GuessedCapacity } from "./extract";
import { safeFetch } from "./networkGuard";
import { classifyPageRelevance, isHomepage, looksTechnicalOnly } from "./relevance";
import { fetchRobotsRules, isPathAllowed } from "./robots";
import { discoverUrlsFromSitemaps, tryDefaultSitemap, type SitemapDiscoveryResult } from "./sitemap";
import { dedupeUrls, inferLanguageFromUrl, normalizeUrl, shouldCrawlUrl } from "./urlPolicy";

export type CrawlPageStatus = "relevant" | "probably_technical" | "unreachable" | "robots_disallowed" | "insufficient_content" | "duplicate";

/** Which budget actually ended the run — see crawlWebsite's final checks, in this priority order when several are simultaneously true. */
export type CrawlStoppedReason = "useful_page_limit" | "fetch_attempt_limit" | "time_limit" | "candidate_exhausted";

export interface CrawlPage {
  /** The URL as discovered/queued (already normalized) — what was actually requested. */
  requestedUrl: string;
  /** Where the request actually landed after any redirects, normalized. THIS is the page's identity — see the module doc below. */
  finalUrl: string;
  /**
   * <link rel="canonical"> declared by the page, if any. Informational
   * only — never used as identity, never deduplicated on, never followed.
   * A real site can declare the same canonical for several distinct-
   * language pages; treating it as identity would silently merge them.
   */
  canonicalUrl: string | null;
  title: string;
  language: string | null;
  contentLength: number;
  status: CrawlPageStatus;
  content: string;
  errorMessage: string | null;
  relevanceScore: number;
  recommended: boolean;
  /** Images found on this page, best-effort — see extract.ts. Empty for terminal/non-useful pages (never fetched or not relevant/probably_technical). */
  images: ExtractedImage[];
  /** A capacity SUGGESTED by this page's own text, if any — never authoritative, see extract.ts. Null for terminal/non-useful pages. */
  guessedCapacity: GuessedCapacity | null;
}

export interface CrawlResult {
  pages: CrawlPage[];
  sitemapUsed: boolean;
  /** Distinct, crawlable candidate URLs seen (sitemap entries + links discovered along the way), whether or not they were actually downloaded. */
  totalCandidateUrls: number;
  /** === pages.length; kept explicit so the two numbers are easy to compare at a glance. */
  processedPages: number;
  /** Among processedPages, how many were "relevant" or "probably_technical" — the number that actually matters for import. See MAX_USEFUL_PAGES. */
  usefulPages: number;
  /** Real HTTP requests actually issued (excludes robots_disallowed, which never fetches). Can exceed usefulPages when a sitemap contains dead links — see MAX_FETCH_ATTEMPTS. */
  fetchAttempts: number;
  /** Candidates that were valid and queued but never downloaded because a budget below was reached first. */
  skippedBecausePageLimit: number;
  /** Language of each PROCESSED page, tallied — "unknown" for pages with no detectable language. */
  countsByDetectedLanguage: Record<string, number>;
  /** Which of the four budgets actually ended the run. */
  stoppedReason: CrawlStoppedReason;
}

interface CrawlOptions {
  websiteUrl: string;
  hotelLanguages: string[];
  defaultLanguage: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface QueueItem {
  url: string;
  depth: number;
  /** Lower = crawled sooner. See computeLanguageTier. */
  tier: number;
}

interface ProcessedPage {
  page: CrawlPage;
  links: string[];
  depth: number;
}

function terminalPage(requestedUrl: string, finalUrl: string, status: CrawlPageStatus, errorMessage: string | null): CrawlPage {
  return {
    requestedUrl,
    finalUrl,
    canonicalUrl: null,
    title: requestedUrl,
    language: null,
    contentLength: 0,
    status,
    content: "",
    errorMessage,
    relevanceScore: 0,
    recommended: false,
    images: [],
    guessedCapacity: null,
  };
}

async function processUrl(item: QueueItem, options: CrawlOptions, robotsAllowed: boolean): Promise<ProcessedPage> {
  if (!robotsAllowed) {
    return { depth: item.depth, links: [], page: terminalPage(item.url, item.url, "robots_disallowed", null) };
  }

  const fetched = await safeFetch(item.url);
  if (!fetched.ok || !fetched.body) {
    return { depth: item.depth, links: [], page: terminalPage(item.url, fetched.finalUrl ?? item.url, "unreachable", fetched.errorMessage ?? "Page inaccessible.") };
  }
  if (fetched.contentType && !fetched.contentType.includes("html")) {
    return { depth: item.depth, links: [], page: terminalPage(item.url, fetched.finalUrl ?? item.url, "unreachable", "Format non HTML.") };
  }

  // finalUrl is normalized here so it's directly usable as the import
  // identity/dedup key downstream (knowledge/actions.ts) without a second
  // normalization pass that could disagree with what the preview showed.
  const finalUrl = normalizeUrl(fetched.finalUrl ?? item.url) ?? (fetched.finalUrl ?? item.url);
  const extracted = extractPage(fetched.body, finalUrl, options.hotelLanguages);
  const links = item.depth < MAX_DEPTH ? extractLinks(fetched.body, finalUrl) : [];

  if (extracted.likelyJsRendered || extracted.text.length === 0) {
    const page: CrawlPage = {
      requestedUrl: item.url,
      finalUrl,
      canonicalUrl: extracted.canonicalUrl,
      title: extracted.title,
      language: extracted.detectedLanguage,
      contentLength: extracted.text.length,
      status: "insufficient_content",
      content: "",
      errorMessage: "Contenu insuffisant — rendu JavaScript probable.",
      relevanceScore: 0,
      recommended: false,
      images: [],
      guessedCapacity: null,
    };
    return { depth: item.depth, links, page };
  }

  const relevance = classifyPageRelevance({ url: finalUrl, title: extracted.title, headings: extracted.headings });
  const technicalOnly = looksTechnicalOnly(finalUrl, extracted.title, relevance.score);
  const status: CrawlPageStatus = technicalOnly ? "probably_technical" : "relevant";
  const isDefaultLanguage = !extracted.detectedLanguage || !options.defaultLanguage || extracted.detectedLanguage === options.defaultLanguage;
  const recommended = status === "relevant" && isDefaultLanguage && (relevance.score > 0 || isHomepage(finalUrl));

  const page: CrawlPage = {
    requestedUrl: item.url,
    finalUrl,
    canonicalUrl: extracted.canonicalUrl,
    title: extracted.title,
    language: extracted.detectedLanguage,
    contentLength: extracted.text.length,
    status,
    content: extracted.text,
    errorMessage: null,
    relevanceScore: relevance.score,
    recommended,
    images: extracted.images,
    guessedCapacity: extracted.guessedCapacity,
  };
  return { depth: item.depth, links, page };
}

/**
 * Best-effort priority, computed from URL structure alone, BEFORE any
 * download — real language is only known for certain after fetching (see
 * extractPage), but sitemaps can hold hundreds of URLs and the useful-page
 * budget only covers a fraction of them, so the crawler has to guess which
 * ones matter most before spending it. Order:
 *
 *   0. the hotel's own default language
 *   1. indeterminate but apparently relevant (homepage, or a path matching
 *      a room/service/etc. keyword) — a real shot at good content even
 *      without a language signal
 *   2. a hotel-configured non-default language — a lower-signal bet than
 *      tier 1, but still a known, deliberate language the hotel actually uses
 *   3. indeterminate AND not apparently relevant — the lowest-signal bucket
 *   4. any other, unconfigured language
 *
 * Tiers 2 and 3 were swapped after real testing against le1837.com: most of
 * a 30-page budget was burned on tier-"indeterminate" candidates that
 * turned out to be dead sitemap entries, before ever reaching the site's
 * genuinely configured other-language pages. Putting known-language
 * candidates ahead of low-signal indeterminate ones gives real multilingual
 * coverage a better chance before the budget runs out on guesses.
 */
function computeLanguageTier(url: string, hreflangHint: string | undefined, options: CrawlOptions): number {
  const inferred = hreflangHint ?? inferLanguageFromUrl(url, options.hotelLanguages) ?? undefined;

  if (options.defaultLanguage && inferred === options.defaultLanguage) return 0;
  if (!inferred) {
    const looksRelevant = classifyPageRelevance({ url, title: "", headings: [] }).score > 0 || isHomepage(url);
    return looksRelevant ? 1 : 3;
  }
  if (options.hotelLanguages.includes(inferred)) return 2;
  return 4;
}

/**
 * Orchestrates one analysis run: robots.txt -> sitemap discovery (preferred
 * seed, inspected up to MAX_CANDIDATE_URLS regardless of the fetch budgets)
 * -> breadth-first link-following as a fallback/supplement. The pending
 * queue is priority-sorted by computeLanguageTier before every batch, not
 * just seeded once in sitemap order — so a site whose sitemap lists many
 * language variants per page still gets its default-language pages crawled
 * first, even as new links keep getting discovered along the way. Stops on
 * whichever of MAX_USEFUL_PAGES / MAX_FETCH_ATTEMPTS / MAX_CANDIDATE_URLS /
 * MAX_CRAWL_DURATION_MS is hit first, or once the queue runs dry — see
 * CrawlResult.stoppedReason and config.ts for why these are separate
 * numbers, not one. Read-only — never writes to the database. That happens only after a
 * human selects pages in the import step (see knowledge/actions.ts).
 */
export async function crawlWebsite(options: CrawlOptions): Promise<CrawlResult> {
  const robotsRules = await fetchRobotsRules(options.websiteUrl);

  let sitemapResult: SitemapDiscoveryResult = robotsRules.sitemaps.length > 0 ? await discoverUrlsFromSitemaps(robotsRules.sitemaps) : { urls: [], hreflangByUrl: {} };
  const sitemapUsed = sitemapResult.urls.length > 0;
  if (!sitemapUsed) {
    sitemapResult = await tryDefaultSitemap(options.websiteUrl);
  }

  const discovered = new Set<string>();
  const queue: QueueItem[] = [];

  function enqueue(rawUrl: string, depth: number) {
    if (discovered.size >= MAX_CANDIDATE_URLS) return;
    const normalized = normalizeUrl(rawUrl);
    if (!normalized || discovered.has(normalized)) return;
    if (!shouldCrawlUrl(normalized, { websiteUrl: options.websiteUrl })) return;

    discovered.add(normalized);
    const hreflangHint = sitemapResult.hreflangByUrl[rawUrl] ?? sitemapResult.hreflangByUrl[normalized];
    queue.push({ url: normalized, depth, tier: computeLanguageTier(normalized, hreflangHint, options) });
  }

  for (const url of dedupeUrls(sitemapResult.urls)) enqueue(url, 0);
  enqueue(options.websiteUrl, 0);

  const visited = new Set<string>();
  const pages: CrawlPage[] = [];
  const seenContent = new Set<string>();
  // Two different requestedUrls can redirect to the identical finalUrl —
  // visited/dedup above only guards the pre-fetch requestedUrl, so this is
  // a separate, post-fetch check. The second one to arrive is marked
  // "duplicate" (never "recommended") regardless of whether its extracted
  // content happens to differ from the first — same finalUrl means same
  // real page, full stop.
  const seenFinalUrls = new Set<string>();

  let usefulPages = 0;
  let fetchAttempts = 0;
  const startedAt = Date.now();

  // pages.length < MAX_CANDIDATE_URLS is a backstop, not a target: a site
  // whose robots.txt disallows almost everything would otherwise loop
  // through its whole candidate set without usefulPages or fetchAttempts
  // ever advancing (robots_disallowed never counts as a fetch attempt).
  // The duration check is between batches only — an in-flight batch is
  // still allowed to finish (bounded by REQUEST_TIMEOUT_MS per request),
  // this just stops a NEW one from starting once time is up.
  while (
    queue.length > 0 &&
    usefulPages < MAX_USEFUL_PAGES &&
    fetchAttempts < MAX_FETCH_ATTEMPTS &&
    pages.length < MAX_CANDIDATE_URLS &&
    Date.now() - startedAt < MAX_CRAWL_DURATION_MS
  ) {
    // Re-sorted every batch (not just once) so newly-discovered links slot into priority order too, not just get appended to the end.
    queue.sort((a, b) => a.tier - b.tier);

    const batch: QueueItem[] = [];
    while (batch.length < CRAWL_CONCURRENCY && queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (visited.has(next.url)) continue;
      visited.add(next.url);
      batch.push(next);
    }
    if (batch.length === 0) continue;

    await sleep(REQUEST_DELAY_MS);

    const batchWithRobots = batch.map((item) => ({
      item,
      robotsAllowed: isPathAllowed(robotsRules, USER_AGENT, new URL(item.url).pathname),
    }));
    const results = await Promise.all(batchWithRobots.map(({ item, robotsAllowed }) => processUrl(item, options, robotsAllowed)));

    for (let i = 0; i < results.length; i++) {
      if (usefulPages >= MAX_USEFUL_PAGES || fetchAttempts >= MAX_FETCH_ATTEMPTS) break;

      const result = results[i];
      if (batchWithRobots[i].robotsAllowed) fetchAttempts++;

      let { page } = result;
      if (page.status === "relevant" || page.status === "probably_technical") {
        if (seenFinalUrls.has(page.finalUrl)) {
          page = { ...page, status: "duplicate", recommended: false };
        } else {
          seenFinalUrls.add(page.finalUrl);
          if (page.content && seenContent.has(page.content)) {
            page = { ...page, status: "duplicate", recommended: false };
          } else if (page.content) {
            seenContent.add(page.content);
          }
        }
      }
      if (page.status === "relevant" || page.status === "probably_technical") usefulPages++;

      pages.push(page);

      for (const link of result.links) enqueue(link, result.depth + 1);
    }
  }

  const countsByDetectedLanguage: Record<string, number> = {};
  for (const page of pages) {
    const key = page.language ?? "unknown";
    countsByDetectedLanguage[key] = (countsByDetectedLanguage[key] ?? 0) + 1;
  }

  // Checked in this order because several can be simultaneously true at
  // exit (e.g. the batch that reaches MAX_USEFUL_PAGES has almost always
  // also pushed elapsed time up) — the most specific/intentional stop
  // condition is reported, not just whichever happens to be checked last.
  let stoppedReason: CrawlStoppedReason;
  if (usefulPages >= MAX_USEFUL_PAGES) {
    stoppedReason = "useful_page_limit";
  } else if (fetchAttempts >= MAX_FETCH_ATTEMPTS) {
    stoppedReason = "fetch_attempt_limit";
  } else if (Date.now() - startedAt >= MAX_CRAWL_DURATION_MS) {
    stoppedReason = "time_limit";
  } else {
    stoppedReason = "candidate_exhausted";
  }

  return {
    pages,
    sitemapUsed,
    totalCandidateUrls: discovered.size,
    processedPages: pages.length,
    usefulPages,
    fetchAttempts,
    skippedBecausePageLimit: Math.max(0, discovered.size - pages.length),
    countsByDetectedLanguage,
    stoppedReason,
  };
}
