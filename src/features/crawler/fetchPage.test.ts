import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchPageContent } from "./fetchPage";
import * as networkGuard from "./networkGuard";
import type { SafeFetchResult } from "./networkGuard";

/**
 * AJOUTER UNE URL chantier — same mocking discipline as crawl.test.ts: only
 * networkGuard.safeFetch is mocked (the sole network entry point), extractPage
 * runs for real against hand-built HTML, exercising the exact same extraction
 * logic crawlWebsite's own processUrl relies on — never a second,
 * independent implementation.
 */
vi.mock("./networkGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./networkGuard")>();
  return { ...actual, safeFetch: vi.fn() };
});

function htmlPage({ lang, text }: { lang: string; text: string }): string {
  return `<html lang="${lang}"><head><title>Superior</title></head><body><main><p>${text}</p></main></body></html>`;
}

function ok(body: string, finalUrl: string, contentType = "text/html"): SafeFetchResult {
  return { ok: true, status: 200, finalUrl, contentType, body };
}

beforeEach(() => {
  vi.mocked(networkGuard.safeFetch).mockReset();
});

describe("fetchPageContent — success path (TEST A)", () => {
  it("[real content, not fabricated] calls safeFetch with the exact URL, extracts real text via extractPage, returns it verbatim", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async (url: string) => {
      expect(url).toBe("https://www.le1837.com/en/superior");
      return ok(htmlPage({ lang: "en", text: "The Superior room accommodates up to 4 people, 40 m², equipped kitchen." }), url);
    });

    const result = await fetchPageContent("https://www.le1837.com/en/superior", ["fr", "en"]);

    expect(networkGuard.safeFetch).toHaveBeenCalledTimes(1);
    expect(networkGuard.safeFetch).toHaveBeenCalledWith("https://www.le1837.com/en/superior");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.finalUrl).toBe("https://www.le1837.com/en/superior");
    expect(result.content).toContain("The Superior room accommodates up to 4 people, 40 m², equipped kitchen.");
    expect(result.language).toBe("en");
  });

  it("[finalUrl normalized] a trailing slash on the real redirect target is stripped, matching accommodation_types.source_url's own convention", async () => {
    const mock = vi.mocked(networkGuard.safeFetch);
    mock.mockImplementation(async () => ok(htmlPage({ lang: "en", text: "Real page content here for the room." }), "https://www.le1837.com/en/superior/"));

    const result = await fetchPageContent("https://www.le1837.com/en/superior", ["en"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok result");
    expect(result.finalUrl).toBe("https://www.le1837.com/en/superior");
  });
});

describe("fetchPageContent — errors, never a fabricated content (TEST B/C)", () => {
  it("[404] a clean error, never a fake success", async () => {
    vi.mocked(networkGuard.safeFetch).mockResolvedValue({ ok: false, status: 404, errorReason: "http_error", errorMessage: "Réponse HTTP 404." });

    const result = await fetchPageContent("https://www.le1837.com/en/does-not-exist", ["en"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.errorReason).toBe("http_error");
  });

  it("[timeout] propagated as a clean error", async () => {
    vi.mocked(networkGuard.safeFetch).mockResolvedValue({ ok: false, errorReason: "timeout", errorMessage: "Délai dépassé." });

    const result = await fetchPageContent("https://www.le1837.com/en/slow", ["en"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.errorReason).toBe("timeout");
  });

  it("[SSRF/network_unsafe refused by safeFetch itself] fetchPageContent never overrides or retries — it only relays the refusal", async () => {
    vi.mocked(networkGuard.safeFetch).mockResolvedValue({ ok: false, errorReason: "network_unsafe", errorMessage: "Ce domaine pointe vers une adresse réseau interne ou réservée." });

    const result = await fetchPageContent("http://169.254.169.254/latest/meta-data", ["en"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.errorReason).toBe("network_unsafe");
    // Exactly one call — no retry loop that could turn a single refusal into repeated probing.
    expect(networkGuard.safeFetch).toHaveBeenCalledTimes(1);
  });

  it("[too_many_redirects — dangerous redirect chain] refused, relayed as-is", async () => {
    vi.mocked(networkGuard.safeFetch).mockResolvedValue({ ok: false, errorReason: "too_many_redirects", errorMessage: "Trop de redirections." });

    const result = await fetchPageContent("https://www.le1837.com/en/redirect-loop", ["en"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.errorReason).toBe("too_many_redirects");
  });

  it("[non-HTML response] rejected before extraction is ever attempted", async () => {
    vi.mocked(networkGuard.safeFetch).mockResolvedValue({ ok: true, status: 200, finalUrl: "https://www.le1837.com/photo.jpg", contentType: "image/jpeg", body: "not-html-binary-placeholder" });

    const result = await fetchPageContent("https://www.le1837.com/photo.jpg", ["en"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.errorReason).toBe("not_html");
  });

  it("[empty/insufficient content, likely JS-rendered] never indexes a blank page as if it had real content", async () => {
    vi.mocked(networkGuard.safeFetch).mockResolvedValue(ok("<html><head><title>App</title></head><body><div id=\"app\"></div></body></html>", "https://www.le1837.com/en/spa-app"));

    const result = await fetchPageContent("https://www.le1837.com/en/spa-app", ["en"]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error result");
    expect(result.errorReason).toBe("insufficient_content");
  });
});
