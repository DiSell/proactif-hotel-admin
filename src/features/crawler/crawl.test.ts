import { describe, expect, it, vi, beforeEach } from "vitest";
import { crawlWebsite } from "./crawl";
import * as networkGuard from "./networkGuard";
import type { SafeFetchResult } from "./networkGuard";

// All network access in this feature funnels through networkGuard.safeFetch
// (robots.ts, sitemap.ts, and crawl.ts itself all call it) — mocking just
// that one function gives full, deterministic control over robots.txt,
// sitemap.xml, and every page's HTML without touching the real network.
vi.mock("./networkGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./networkGuard")>();
  return { ...actual, safeFetch: vi.fn() };
});

function htmlPage({ lang, canonical, text }: { lang: string; canonical?: string; text: string }): string {
  return `<html lang="${lang}"><head><title>Page ${lang}</title>${
    canonical ? `<link rel="canonical" href="${canonical}">` : ""
  }</head><body><main><p>${text}</p></main></body></html>`;
}

function sitemapXml(urls: string[]): string {
  return `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
}

function ok(body: string, finalUrl: string, contentType = "text/html"): SafeFetchResult {
  return { ok: true, status: 200, finalUrl, contentType, body };
}

function notFound(): SafeFetchResult {
  return { ok: false, status: 404, errorReason: "http_error", errorMessage: "Réponse HTTP 404." };
}

describe("crawlWebsite — canonical is never used as page identity", () => {
  beforeEach(() => {
    vi.mocked(networkGuard.safeFetch).mockReset();
  });

  it("[1] two pages declaring the same canonical remain two distinct CrawlPages", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        return ok(sitemapXml(["https://example.com/en/page", "https://example.com/es/page"]), url, "application/xml");
      }
      if (url === "https://example.com/en/page") {
        return ok(htmlPage({ lang: "en", canonical: "https://example.com/page", text: "English content lives here for the room." }), url);
      }
      if (url === "https://example.com/es/page") {
        return ok(htmlPage({ lang: "es", canonical: "https://example.com/page", text: "Contenido en español para la habitación aquí." }), url);
      }
      return ok(htmlPage({ lang: "en", text: "Home content for the establishment right here." }), url);
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en", "es"], defaultLanguage: "en" });

    const enPage = result.pages.find((p) => p.finalUrl === "https://example.com/en/page");
    const esPage = result.pages.find((p) => p.finalUrl === "https://example.com/es/page");
    expect(enPage).toBeDefined();
    expect(esPage).toBeDefined();
    expect(enPage!.status).not.toBe("duplicate");
    expect(esPage!.status).not.toBe("duplicate");
    expect(enPage!.finalUrl).not.toBe(esPage!.finalUrl);
    // The canonical is captured (informational) but identical on both — proof it was never the dedup key.
    expect(enPage!.canonicalUrl).toBe("https://example.com/page");
    expect(esPage!.canonicalUrl).toBe("https://example.com/page");
  });

  it("[3] a canonical pointing off-domain is never fetched/navigated to, and stays purely informational", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    const calledUrls: string[] = [];
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      calledUrls.push(url);
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        return ok(sitemapXml(["https://example.com/page"]), url, "application/xml");
      }
      if (url === "https://example.com/page") {
        return ok(htmlPage({ lang: "en", canonical: "https://third-party.example.com/elsewhere", text: "Real content stays on this domain here." }), url);
      }
      return ok(htmlPage({ lang: "en", text: "Home content for the establishment right here." }), url);
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en"], defaultLanguage: "en" });

    expect(calledUrls).not.toContain("https://third-party.example.com/elsewhere");
    const page = result.pages.find((p) => p.finalUrl === "https://example.com/page");
    expect(page).toBeDefined();
    expect(page!.canonicalUrl).toBe("https://third-party.example.com/elsewhere");
  });

  it("two different requestedUrls that redirect to the same finalUrl: two preview rows, only one importable", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        return ok(sitemapXml(["https://example.com/a", "https://example.com/b"]), url, "application/xml");
      }
      // Both requestedUrls (a and b) redirect to the identical finalUrl.
      if (url === "https://example.com/a") {
        return ok(htmlPage({ lang: "en", text: "Content reached via requestedUrl A here." }), "https://example.com/x");
      }
      if (url === "https://example.com/b") {
        return ok(htmlPage({ lang: "en", text: "Different wording reached via requestedUrl B." }), "https://example.com/x");
      }
      return ok(htmlPage({ lang: "en", text: "Home content for the establishment right here." }), url);
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en"], defaultLanguage: "en" });

    const rowsAtX = result.pages.filter((p) => p.finalUrl === "https://example.com/x");
    // [required] two preview rows exist for the same finalUrl...
    expect(rowsAtX).toHaveLength(2);
    expect(rowsAtX.map((p) => p.requestedUrl).sort()).toEqual(["https://example.com/a", "https://example.com/b"]);
    // ...but only one is actually importable: the other is marked duplicate and never pre-checked.
    const importable = rowsAtX.filter((p) => p.status !== "duplicate");
    const duplicates = rowsAtX.filter((p) => p.status === "duplicate");
    expect(importable).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.recommended).toBe(false);
  });
});

describe("crawlWebsite — language priority (point B)", () => {
  beforeEach(() => {
    vi.mocked(networkGuard.safeFetch).mockReset();
  });

  it("crawls the hotel's default-language pages before other configured languages, even when the sitemap lists them last", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    const fetchOrder: string[] = [];
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        // Deliberately listed EN/ES first, FR last — proves ordering isn't sitemap order.
        return ok(
          sitemapXml([
            "https://example.com/en/a",
            "https://example.com/es/a",
            "https://example.com/en/b",
            "https://example.com/es/b",
            "https://example.com/fr/a",
            "https://example.com/fr/b",
          ]),
          url,
          "application/xml"
        );
      }
      fetchOrder.push(url);
      const langMatch = url.match(/\/(en|es|fr)\//);
      const lang = langMatch ? langMatch[1] : "en";
      return ok(htmlPage({ lang, text: `Content for this page in language ${lang} right here.` }), url);
    });

    await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["fr", "en", "es"], defaultLanguage: "fr" });

    const frIndexes = fetchOrder.map((u, i) => (u.includes("/fr/") ? i : -1)).filter((i) => i >= 0);
    const otherIndexes = fetchOrder
      .map((u, i) => (!u.includes("/fr/") && u !== "https://example.com/" ? i : -1))
      .filter((i) => i >= 0);
    expect(Math.max(...frIndexes)).toBeLessThan(Math.min(...otherIndexes));
  });
});

describe("crawlWebsite — observability (point D)", () => {
  beforeEach(() => {
    vi.mocked(networkGuard.safeFetch).mockReset();
  });

  it("reports candidate/processed/skipped counts and a per-language tally", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        return ok(sitemapXml(["https://example.com/a", "https://example.com/b"]), url, "application/xml");
      }
      if (url === "https://example.com/a") return ok(htmlPage({ lang: "en", text: "Content A for the establishment here." }), url);
      if (url === "https://example.com/b") return ok(htmlPage({ lang: "fr", text: "Contenu B pour l'établissement ici même." }), url);
      return ok(htmlPage({ lang: "en", text: "Home content for the establishment right here." }), url);
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en", "fr"], defaultLanguage: "en" });

    expect(result.processedPages).toBe(result.pages.length);
    expect(result.totalCandidateUrls).toBeGreaterThanOrEqual(3); // a, b, home
    expect(result.skippedBecausePageLimit).toBe(0); // well under either budget
    expect(result.countsByDetectedLanguage.en).toBeGreaterThanOrEqual(1);
    expect(result.countsByDetectedLanguage.fr).toBeGreaterThanOrEqual(1);
  });

  it("[MAX_USEFUL_PAGES / MAX_FETCH_ATTEMPTS split] fetchAttempts counts dead sitemap entries that usefulPages does not", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        // A stale sitemap: two dead links for every one real page — mirrors the real le1837.com finding.
        return ok(
          sitemapXml([
            "https://example.com/dead-1",
            "https://example.com/dead-2",
            "https://example.com/real-a",
            "https://example.com/dead-3",
            "https://example.com/dead-4",
            "https://example.com/real-b",
          ]),
          url,
          "application/xml"
        );
      }
      if (url === "https://example.com/real-a" || url === "https://example.com/real-b") {
        return ok(htmlPage({ lang: "en", text: `Real content at ${url}, definitely useful for the establishment.` }), url);
      }
      if (url.includes("/dead-")) return notFound();
      return ok(htmlPage({ lang: "en", text: "Home content for the establishment right here." }), url);
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en"], defaultLanguage: "en" });

    // 2 real pages + 1 home = 3 useful; the 4 dead links each still cost a fetch attempt.
    expect(result.usefulPages).toBe(3);
    expect(result.fetchAttempts).toBeGreaterThanOrEqual(7); // 4 dead + real-a + real-b + home
    expect(result.fetchAttempts).toBeGreaterThan(result.usefulPages);
  });
});

describe("crawlWebsite — language tier ordering (point B refinement)", () => {
  beforeEach(() => {
    vi.mocked(networkGuard.safeFetch).mockReset();
  });

  it("crawls a hotel-configured non-default language before an indeterminate, non-relevant URL", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    const fetchOrder: string[] = [];
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        // Indeterminate-and-not-relevant listed FIRST, configured-other-language listed LAST.
        return ok(
          sitemapXml(["https://example.com/qzplm-nonsense", "https://example.com/es/pagina"]),
          url,
          "application/xml"
        );
      }
      fetchOrder.push(url);
      const lang = url.includes("/es/") ? "es" : "en";
      return ok(htmlPage({ lang, text: `Content at ${url}, long enough here for the establishment yes indeed.` }), url);
    });

    await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en", "es"], defaultLanguage: "en" });

    const homeIndex = fetchOrder.indexOf("https://example.com/");
    const esIndex = fetchOrder.indexOf("https://example.com/es/pagina");
    const nonsenseIndex = fetchOrder.indexOf("https://example.com/qzplm-nonsense");
    expect(esIndex).toBeGreaterThan(-1);
    expect(nonsenseIndex).toBeGreaterThan(-1);
    // The configured-language page (tier 2) is fetched before the indeterminate/irrelevant one (tier 3),
    // even though the sitemap listed it last — home (indeterminate+relevant, tier 1) still comes first.
    expect(esIndex).toBeLessThan(nonsenseIndex);
    if (homeIndex >= 0) expect(homeIndex).toBeLessThan(esIndex);
  });
});
