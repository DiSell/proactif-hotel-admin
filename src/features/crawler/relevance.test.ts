import { describe, expect, it } from "vitest";
import { classifyPageRelevance, isHomepage, looksTechnicalOnly } from "./relevance";

describe("classifyPageRelevance", () => {
  it("matches rooms/spa/pool keywords across French, English, and Spanish", () => {
    expect(classifyPageRelevance({ url: "https://x.com/chambres", title: "", headings: [] }).matchedCategories).toContain("rooms");
    expect(classifyPageRelevance({ url: "https://x.com/rooms", title: "", headings: [] }).matchedCategories).toContain("rooms");
    expect(classifyPageRelevance({ url: "https://x.com/habitaciones", title: "", headings: [] }).matchedCategories).toContain("rooms");
    expect(classifyPageRelevance({ url: "https://x.com/spa", title: "", headings: [] }).matchedCategories).toContain("spa");
    expect(classifyPageRelevance({ url: "https://x.com/piscine", title: "", headings: [] }).matchedCategories).toContain("pool");
  });

  it("scores a page matching several categories higher than one matching none", () => {
    const rich = classifyPageRelevance({ url: "https://x.com/spa-piscine", title: "Notre spa et piscine", headings: ["Spa", "Piscine chauffée"] });
    const generic = classifyPageRelevance({ url: "https://x.com/mentions-legales", title: "Mentions légales", headings: [] });
    expect(rich.score).toBeGreaterThan(generic.score);
  });

  it("never asserts the hotel actually has the matched amenity — it's a priority signal only", () => {
    // A page merely mentioning "spa" in its URL is not proof of a spa; classifyPageRelevance only
    // returns a category label + score, never a boolean claim like `hasSpa: true`.
    const result = classifyPageRelevance({ url: "https://x.com/spa", title: "", headings: [] });
    expect(result).not.toHaveProperty("hasSpa");
    expect(Object.keys(result)).toEqual(["matchedCategories", "score"]);
  });
});

describe("isHomepage", () => {
  it("recognizes the root path as the homepage", () => {
    expect(isHomepage("https://example.com/")).toBe(true);
    expect(isHomepage("https://example.com")).toBe(true);
  });

  it("rejects any other path", () => {
    expect(isHomepage("https://example.com/chambres")).toBe(false);
  });
});

describe("looksTechnicalOnly", () => {
  it("flags a legal/privacy page with zero relevance signal as technical-only", () => {
    expect(looksTechnicalOnly("https://x.com/mentions-legales", "Mentions légales", 0)).toBe(true);
    expect(looksTechnicalOnly("https://x.com/privacy-policy", "Privacy Policy", 0)).toBe(true);
  });

  it("does not flag a page that also has real relevance signal", () => {
    expect(looksTechnicalOnly("https://x.com/spa/privacy", "Spa - conditions", 2)).toBe(false);
  });

  it("does not flag an ordinary content page", () => {
    expect(looksTechnicalOnly("https://x.com/a-propos", "À propos", 0)).toBe(false);
  });
});
