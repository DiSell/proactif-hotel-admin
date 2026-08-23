import { describe, expect, it, vi, beforeEach } from "vitest";
import { crawlWebsite } from "./crawl";
import * as networkGuard from "./networkGuard";
import type { SafeFetchResult } from "./networkGuard";

// Small, deterministic budgets for this file only — MAX_CRAWL_DURATION_MS
// stays generous here (real time-limit behavior has its own dedicated file,
// crawl.timeLimit.test.ts) so these tests isolate useful/fetch/candidate
// exhaustion without real elapsed time interfering.
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, MAX_USEFUL_PAGES: 1, MAX_FETCH_ATTEMPTS: 2, MAX_CRAWL_DURATION_MS: 30_000 };
});

vi.mock("./networkGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./networkGuard")>();
  return { ...actual, safeFetch: vi.fn() };
});

function htmlPage(text: string): string {
  return `<html lang="en"><head><title>P</title></head><body><main><p>${text}</p></main></body></html>`;
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

describe("crawlWebsite — stoppedReason (MAX_USEFUL_PAGES=1, MAX_FETCH_ATTEMPTS=2)", () => {
  beforeEach(() => {
    vi.mocked(networkGuard.safeFetch).mockReset();
  });

  it("[useful_page_limit] stops once MAX_USEFUL_PAGES is reached", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      // The sitemap's only entry IS the homepage — exactly one real candidate, no ambiguity from the auto-enqueued home.
      if (url === "https://example.com/sitemap.xml") return ok(sitemapXml(["https://example.com/"]), url, "application/xml");
      return ok(htmlPage("Real useful content for the establishment right here."), url);
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en"], defaultLanguage: "en" });

    expect(result.usefulPages).toBe(1);
    expect(result.stoppedReason).toBe("useful_page_limit");
  });

  it("[fetch_attempt_limit] stops once MAX_FETCH_ATTEMPTS is reached, before finding anything useful", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        return ok(sitemapXml(["https://example.com/dead-1", "https://example.com/dead-2"]), url, "application/xml");
      }
      // Everything 404s, including the homepage itself — no candidate here can become "useful".
      return notFound();
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en"], defaultLanguage: "en" });

    expect(result.usefulPages).toBe(0);
    expect(result.fetchAttempts).toBe(2);
    expect(result.stoppedReason).toBe("fetch_attempt_limit");
  });

  it("[candidate_exhausted] stops because the queue ran dry, well under every budget", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") return ok(sitemapXml(["https://example.com/"]), url, "application/xml");
      // Almost no visible text alongside several scripts -> "insufficient_content", never counted as useful.
      return ok(
        `<html lang="en"><head><script>a()</script><script>b()</script><script>c()</script><script>d()</script></head><body><div id="root"></div></body></html>`,
        url
      );
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en"], defaultLanguage: "en" });

    expect(result.usefulPages).toBe(0);
    expect(result.fetchAttempts).toBe(1);
    expect(result.pages.some((p) => p.status === "insufficient_content")).toBe(true);
    expect(result.stoppedReason).toBe("candidate_exhausted");
  });
});
