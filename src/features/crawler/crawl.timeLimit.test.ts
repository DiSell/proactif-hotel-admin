import { describe, expect, it, vi, beforeEach } from "vitest";
import { crawlWebsite } from "./crawl";
import * as networkGuard from "./networkGuard";
import type { SafeFetchResult } from "./networkGuard";

// Generous useful/fetch budgets (never reached) so only MAX_CRAWL_DURATION_MS
// can end this run — isolated from crawl.stopReasons.test.ts's tiny budgets,
// which would otherwise interfere with each other in a shared mock.
vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return { ...actual, MAX_USEFUL_PAGES: 100, MAX_FETCH_ATTEMPTS: 100, MAX_CRAWL_DURATION_MS: 50 };
});

vi.mock("./networkGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./networkGuard")>();
  return { ...actual, safeFetch: vi.fn() };
});

function sitemapXml(urls: string[]): string {
  return `<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
}
function notFound(): SafeFetchResult {
  return { ok: false, status: 404, errorReason: "http_error", errorMessage: "Réponse HTTP 404." };
}

describe("crawlWebsite — [time_limit] MAX_CRAWL_DURATION_MS", () => {
  beforeEach(() => {
    vi.mocked(networkGuard.safeFetch).mockReset();
  });

  it("stops between batches once the wall-clock budget is exceeded, even with candidates and fetch attempts still available", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string): Promise<SafeFetchResult> => {
      if (url === "https://example.com/robots.txt") return notFound();
      if (url === "https://example.com/sitemap.xml") {
        // Six dead links: with concurrency 2 and the real REQUEST_DELAY_MS
        // between batches, reaching all of them takes noticeably longer
        // than the 50ms budget above — every one is well under the
        // (unreached) MAX_FETCH_ATTEMPTS=100 too.
        return ok(
          sitemapXml([
            "https://example.com/a",
            "https://example.com/b",
            "https://example.com/c",
            "https://example.com/d",
            "https://example.com/e",
            "https://example.com/f",
          ]),
          url,
          "application/xml"
        );
      }
      return notFound();
    });

    const result = await crawlWebsite({ websiteUrl: "https://example.com", hotelLanguages: ["en"], defaultLanguage: "en" });

    expect(result.stoppedReason).toBe("time_limit");
    expect(result.usefulPages).toBeLessThan(100);
    expect(result.fetchAttempts).toBeLessThan(100);
    // Didn't get through every candidate — proof it stopped early because of time, not because it ran out of work.
    expect(result.skippedBecausePageLimit).toBeGreaterThan(0);
  });
});

function ok(body: string, finalUrl: string, contentType = "application/xml"): SafeFetchResult {
  return { ok: true, status: 200, finalUrl, contentType, body };
}
