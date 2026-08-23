import { describe, expect, it } from "vitest";
import { isPathAllowed, parseRobotsTxt } from "./robots";

const SAMPLE_ROBOTS = `
User-agent: *
Disallow: /wp-admin/
Disallow: /panier
Allow: /wp-admin/admin-ajax.php
Sitemap: https://example.com/sitemap.xml

User-agent: ProactifSystemBot
Disallow: /private/

User-agent: BadBot
Disallow: /
`;

describe("parseRobotsTxt", () => {
  it("groups rules under their User-agent block and collects Sitemap lines", () => {
    const rules = parseRobotsTxt(SAMPLE_ROBOTS);
    expect(rules.groups).toHaveLength(3);
    expect(rules.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });

  it("ignores comments", () => {
    const rules = parseRobotsTxt("# comment\nUser-agent: *\nDisallow: /a # inline comment\n");
    expect(rules.groups[0].rules[0].path).toBe("/a");
  });
});

describe("isPathAllowed", () => {
  const rules = parseRobotsTxt(SAMPLE_ROBOTS);

  it("disallows a path blocked for *", () => {
    expect(isPathAllowed(rules, "SomeOtherBot/1.0", "/panier")).toBe(false);
  });

  it("allows a path not mentioned in any applicable rule", () => {
    expect(isPathAllowed(rules, "SomeOtherBot/1.0", "/chambres")).toBe(true);
  });

  it("lets a longer Allow rule override a shorter Disallow within the same group", () => {
    expect(isPathAllowed(rules, "SomeOtherBot/1.0", "/wp-admin/admin-ajax.php")).toBe(true);
    expect(isPathAllowed(rules, "SomeOtherBot/1.0", "/wp-admin/edit.php")).toBe(false);
  });

  it("prefers a specific user-agent group over the wildcard group", () => {
    // ProactifSystemBot's own group only disallows /private/ — it is NOT blocked from /panier,
    // even though the wildcard group blocks /panier, because the more specific group wins outright.
    expect(isPathAllowed(rules, "ProactifSystemBot/1.0", "/panier")).toBe(true);
    expect(isPathAllowed(rules, "ProactifSystemBot/1.0", "/private/notes")).toBe(false);
  });

  it("respects a full-site disallow for a specifically named bot", () => {
    expect(isPathAllowed(rules, "BadBot/2.0", "/anything")).toBe(false);
  });

  it("allows everything when there are no applicable rules at all", () => {
    const empty = parseRobotsTxt("");
    expect(isPathAllowed(empty, "ProactifSystemBot/1.0", "/anything")).toBe(true);
  });
});
