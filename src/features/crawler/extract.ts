import * as cheerio from "cheerio";
import { MAX_IMAGES_PER_PAGE, MIN_CONTENT_CHARS } from "./config";
import { inferLanguageFromUrl } from "./urlPolicy";

export interface ExtractedImage {
  url: string;
  alt: string | null;
  /** Nearest preceding h1/h2/h3 in the DOM, if any — a best-effort SUGGESTION for the admin curation UI, never authoritative. */
  nearbyHeading: string | null;
}

/**
 * A number the page text itself suggests as a capacity, alongside the exact
 * snippet it was found in — a SUGGESTION only, pre-filled in the admin
 * curation UI and never written to accommodation_types.max_guests without
 * explicit human confirmation. See crawl.ts / actions.ts.
 */
export interface GuessedCapacity {
  value: number;
  matchedText: string;
}

export interface ExtractedPage {
  /**
   * The <link rel="canonical"> declared by the page, if any — PURELY
   * INFORMATIONAL. Never treated as a page's identity anywhere downstream:
   * a real site can (and le1837.com does) declare the same canonical for
   * several distinct-language pages, which would silently collapse them
   * into one if this were used as a key. See crawl.ts's requestedUrl/
   * finalUrl for the actual identity, and this field is never auto-followed.
   */
  canonicalUrl: string | null;
  title: string;
  metaDescription: string | null;
  headings: string[];
  text: string;
  detectedLanguage: string | null;
  likelyJsRendered: boolean;
  images: ExtractedImage[];
  guessedCapacity: GuessedCapacity | null;
}

/**
 * Real heading tags (h1-h6) found anywhere in the noise-stripped tree,
 * turned into their own markdown-style marker line (`"#".repeat(level) +
 * " " + text`) IN PLACE, so that when the caller later reads
 * `container.text()`, each heading survives as an isolated, identifiable
 * paragraph at its exact original DOM position — never reordered, never
 * fabricated. This is the ONLY structural signal added: no heading is
 * invented, no section is guessed from CSS classes or visual layout, only
 * tags the page's own author already marked as headings.
 *
 * Runs on $content (the noise-stripped tree used for `text`), never on the
 * first-pass `$` used for title/meta/the plain `headings` array — that
 * array must stay the original, un-prefixed heading strings (used for
 * relevance scoring and capacity-guessing, not for structural chunking).
 *
 * Deliberately called AFTER extractImages(): that function also reads
 * headings (nearAll/closest "h1, h2, h3" for `nearbyHeading`) and must see
 * their original, unprefixed text — mutating headings first would leak a
 * "## " prefix into that cosmetic suggestion.
 *
 * `\n\n` is added explicitly around the marker rather than relying on
 * whatever incidental whitespace the source HTML happens to have between
 * tags — minified HTML (no inter-tag whitespace at all) would otherwise
 * fail to isolate the heading as its own paragraph once collapseWhitespace
 * runs. An empty heading (no text at all) is removed outright rather than
 * emitted as a bare "#" marker with nothing to head.
 */
function markHeadingsForStructuredText($content: cheerio.CheerioAPI): void {
  $content("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const level = Number(el.tagName.slice(1));
    const headingText = $content(el).text().replace(/\s+/g, " ").trim();
    if (!headingText) {
      $content(el).remove();
      return;
    }
    $content(el).text(`\n\n${"#".repeat(level)} ${headingText}\n\n`);
  });
}

/**
 * Elements stripped before reading the "main content" text — navigation,
 * chrome, and technical noise that document.body.innerText would otherwise
 * include verbatim. Not perfect for every site generator, but a real
 * improvement over reading the whole document blindly; the human review
 * step (see the import UI) is the actual safety net for what slips through.
 */
const NOISE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "form",
  "nav",
  "footer",
  "header",
  "[aria-hidden='true']",
  "[class*='cookie' i]",
  "[id*='cookie' i]",
  "[class*='banner' i]",
  "[class*='menu' i]",
  "[id*='menu' i]",
  "[role='navigation']",
  "[role='banner']",
  "[role='contentinfo']",
].join(", ");

function safeResolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Best-effort <img> extraction, run on the tree ALREADY stripped of
 * NOISE_SELECTORS (nav/footer/header/etc.) so site-wide logos and nav icons
 * aren't captured on every single page. nearbyHeading is a simple
 * document-position heuristic (nearest preceding sibling heading, else the
 * closest containing section/article/li's first heading) — good enough as
 * a pre-filled suggestion for the admin curation UI, never authoritative.
 * Capped at MAX_IMAGES_PER_PAGE so one image-heavy page can't blow up the
 * review UI.
 */
function extractImages($content: cheerio.CheerioAPI, baseUrl: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];
  $content("img[src]").each((_, el) => {
    if (images.length >= MAX_IMAGES_PER_PAGE) return false;
    const src = $content(el).attr("src");
    if (!src) return;
    const url = safeResolve(src, baseUrl);
    if (!url) return;

    const alt = $content(el).attr("alt")?.trim() || null;
    const precedingSibling = $content(el).prevAll("h1, h2, h3").first();
    const containerHeading = $content(el).closest("section, article, li").find("h1, h2, h3").first();
    const nearbyHeading = (precedingSibling.length ? precedingSibling : containerHeading).text().trim() || null;

    images.push({ url, alt, nearbyHeading });
  });
  return images;
}

/**
 * Numbers a page's own text/headings SUGGEST as a capacity — e.g. "jusqu'à
 * 6 personnes", "sleeps 4", "max 3 guests". Deliberately narrow (explicit
 * phrasings only, sanity-bounded to 1-30) and never authoritative: the
 * result is a pre-filled SUGGESTION in the admin curation UI (see
 * crawl.ts/actions.ts), never written to accommodation_types.max_guests
 * without explicit human confirmation. No match -> null, never a guess.
 */
// \b immediately before each digit group is load-bearing: without it, a
// number like "120" could match as "20" (the pattern only allows 1-2
// digits, and an unanchored search would otherwise happily match the tail
// of a longer number) — the boundary requires the digit group to actually
// start a fresh number, not continue one.
const CAPACITY_PATTERNS: RegExp[] = [
  /jusqu.?\s*[àa]\s*\b(\d{1,2})\s*personnes?/i,
  /\b(\d{1,2})\s*pers\.?\b/i,
  /\b(\d{1,2})\s*personnes?/i,
  /sleeps?\s*\b(\d{1,2})/i,
  /up to\s*\b(\d{1,2})\s*guests?/i,
  /max\.?\s*\b(\d{1,2})\s*guests?/i,
  /hasta\s*\b(\d{1,2})\s*personas/i,
];

function guessCapacity(text: string, headings: string[]): GuessedCapacity | null {
  for (const haystack of [...headings, text]) {
    for (const pattern of CAPACITY_PATTERNS) {
      const match = haystack.match(pattern);
      if (!match) continue;
      const value = parseInt(match[1], 10);
      if (value >= 1 && value <= 30) {
        return { value, matchedText: match[0].trim() };
      }
    }
  }
  return null;
}

function detectLanguage($: cheerio.CheerioAPI, fetchedUrl: string, knownLanguages: string[]): string | null {
  const htmlLang = $("html").attr("lang");
  if (htmlLang) return htmlLang.split("-")[0].toLowerCase();
  return inferLanguageFromUrl(fetchedUrl, knownLanguages);
}

/**
 * Extracts title, meta description, headings, canonical URL, cleaned main
 * text, and a best-effort detected language from raw HTML. Also flags pages
 * that likely depend on client-side rendering (very little visible text
 * alongside several script tags) rather than guessing at their content —
 * see MIN_CONTENT_CHARS in config.ts.
 */
export function extractPage(html: string, fetchedUrl: string, knownLanguages: string[]): ExtractedPage {
  const $ = cheerio.load(html);

  // Never falls back to fetchedUrl — a missing or unresolvable canonical is
  // reported as null (no canonical info available), never silently
  // substituted with the page's own URL, so callers can't mistake "no
  // canonical declared" for "canonical equals this page".
  const canonicalHref = $('link[rel="canonical"]').first().attr("href");
  const canonicalUrl = canonicalHref ? safeResolve(canonicalHref, fetchedUrl) : null;

  const title = $("title").first().text().trim() || $("h1").first().text().trim() || fetchedUrl;
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || null;
  const headings = $("h1, h2")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  const scriptCount = $("script").length;

  const detectedLanguage = detectLanguage($, fetchedUrl, knownLanguages);

  // Cleaning mutates the tree, so it runs on a second parse of the same
  // HTML — keeps the title/heading/meta reads above unaffected by it.
  const $content = cheerio.load(html);
  $content(NOISE_SELECTORS).remove();
  const container = $content("main").length ? $content("main") : $content("article").length ? $content("article") : $content("body");

  // Images and capacity are read from the same noise-stripped $content tree
  // used for `text` — same reasoning: skip repeated nav/footer chrome.
  // Must run BEFORE markHeadingsForStructuredText (see that function's own
  // comment) so `nearbyHeading` still sees each heading's real text.
  const images = extractImages($content, fetchedUrl);

  markHeadingsForStructuredText($content);
  const text = collapseWhitespace(container.text());

  const likelyJsRendered = text.length < MIN_CONTENT_CHARS && scriptCount > 3;

  const guessedCapacity = guessCapacity(text, headings);

  return { canonicalUrl, title, metaDescription, headings, text, detectedLanguage, likelyJsRendered, images, guessedCapacity };
}

/** Every same-page href found on a page, resolved to absolute URLs. Filtering (domain, exclusions) happens in urlPolicy, not here. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const resolved = safeResolve(href, baseUrl);
    if (resolved) links.push(resolved);
  });
  return links;
}
