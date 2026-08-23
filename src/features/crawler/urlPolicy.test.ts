import { describe, expect, it } from "vitest";
import { dedupeUrls, inferLanguageFromUrl, isSameDomain, normalizeUrl, shouldCrawlUrl, shouldIndexPage } from "./urlPolicy";

describe("normalizeUrl", () => {
  it("strips the fragment", () => {
    expect(normalizeUrl("https://example.com/chambres#tarifs")).toBe("https://example.com/chambres");
  });

  it("removes tracking query params but keeps real ones", () => {
    const result = normalizeUrl("https://example.com/offres?utm_source=fb&room=deluxe");
    expect(result).not.toContain("utm_source");
    expect(result).toContain("room=deluxe");
  });

  it("drops a trailing slash except on the root", () => {
    expect(normalizeUrl("https://example.com/chambres/")).toBe("https://example.com/chambres");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com/");
  });

  it("lowercases the hostname", () => {
    expect(normalizeUrl("https://EXAMPLE.com/Chambres")).toContain("example.com");
  });

  it("rejects non-http(s) schemes", () => {
    expect(normalizeUrl("mailto:contact@example.com")).toBeNull();
    expect(normalizeUrl("tel:+33500000000")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(normalizeUrl("not a url")).toBeNull();
  });
});

describe("isSameDomain", () => {
  it("treats www and non-www as the same site", () => {
    expect(isSameDomain("https://www.example.com/chambres", "https://example.com")).toBe(true);
    expect(isSameDomain("https://example.com/chambres", "https://www.example.com")).toBe(true);
  });

  it("rejects a different domain", () => {
    expect(isSameDomain("https://booking.com/hotel/example", "https://example.com")).toBe(false);
  });

  it("rejects a subdomain that isn't just www", () => {
    expect(isSameDomain("https://blog.example.com", "https://example.com")).toBe(false);
  });
});

describe("shouldCrawlUrl", () => {
  const options = { websiteUrl: "https://example.com" };

  it("allows an ordinary same-domain content page", () => {
    expect(shouldCrawlUrl("https://example.com/chambres", options)).toBe(true);
  });

  it("rejects a different domain, e.g. a Booking.com or Instagram link", () => {
    expect(shouldCrawlUrl("https://www.booking.com/hotel/fr/example.html", options)).toBe(false);
    expect(shouldCrawlUrl("https://instagram.com/exemplehotel", options)).toBe(false);
  });

  it("rejects mailto:/tel:/javascript: links", () => {
    expect(shouldCrawlUrl("mailto:contact@example.com", options)).toBe(false);
    expect(shouldCrawlUrl("tel:+33500000000", options)).toBe(false);
    expect(shouldCrawlUrl("javascript:void(0)", options)).toBe(false);
  });

  it("rejects known asset extensions", () => {
    expect(shouldCrawlUrl("https://example.com/logo.png", options)).toBe(false);
    expect(shouldCrawlUrl("https://example.com/styles.css", options)).toBe(false);
    expect(shouldCrawlUrl("https://example.com/brochure.pdf", options)).toBe(false);
  });

  it("rejects admin/login/cart/checkout paths", () => {
    expect(shouldCrawlUrl("https://example.com/wp-admin/", options)).toBe(false);
    expect(shouldCrawlUrl("https://example.com/login", options)).toBe(false);
    expect(shouldCrawlUrl("https://example.com/panier", options)).toBe(false);
    expect(shouldCrawlUrl("https://example.com/checkout", options)).toBe(false);
  });

  it("rejects a calendar-style URL likely to generate infinite pages", () => {
    expect(shouldCrawlUrl("https://example.com/booking?checkin=2026-06-01", options)).toBe(false);
  });
});

describe("shouldIndexPage", () => {
  it("flags a duplicate regardless of content length", () => {
    expect(shouldIndexPage({ text: "a".repeat(1000), isDuplicate: true })).toBe("duplicate");
  });

  it("flags content below the minimum length as insufficient", () => {
    expect(shouldIndexPage({ text: "too short", isDuplicate: false })).toBe("insufficient_content");
  });

  it("accepts sufficiently long, non-duplicate content as relevant", () => {
    expect(shouldIndexPage({ text: "a".repeat(500), isDuplicate: false })).toBe("relevant");
  });
});

describe("dedupeUrls", () => {
  it("removes duplicates that normalize to the same URL", () => {
    const result = dedupeUrls([
      "https://example.com/chambres",
      "https://example.com/chambres/",
      "https://example.com/chambres#section",
      "https://example.com/chambres?utm_source=fb",
    ]);
    expect(result).toHaveLength(1);
  });

  it("preserves distinct URLs and first-seen order", () => {
    const result = dedupeUrls(["https://example.com/a", "https://example.com/b", "https://example.com/a"]);
    expect(result).toEqual(["https://example.com/a", "https://example.com/b"]);
  });
});

describe("inferLanguageFromUrl", () => {
  const known = ["fr", "en", "es"];

  it("detects a language path segment", () => {
    expect(inferLanguageFromUrl("https://example.com/en/rooms", known)).toBe("en");
    expect(inferLanguageFromUrl("https://example.com/fr/chambres", known)).toBe("fr");
  });

  it("detects a lang query parameter", () => {
    expect(inferLanguageFromUrl("https://example.com/rooms?lang=es", known)).toBe("es");
  });

  it("never returns a language the hotel hasn't configured", () => {
    expect(inferLanguageFromUrl("https://example.com/nl/kamers", known)).toBeNull();
  });

  it("returns null when nothing in the URL indicates a language", () => {
    expect(inferLanguageFromUrl("https://example.com/rooms", known)).toBeNull();
  });

  it("returns null for garbage input instead of throwing", () => {
    expect(inferLanguageFromUrl("not a url", known)).toBeNull();
  });
});
