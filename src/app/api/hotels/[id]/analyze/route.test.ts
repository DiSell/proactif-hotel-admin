import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "route.ts"), "utf8");

/**
 * Regression guards for the domain-authorization check: the route touches
 * Supabase and Next.js request context directly, so it can't be exercised
 * as a real unit test here (same constraint as elsewhere in this codebase)
 * — checked at the source level instead.
 */
describe("POST /api/hotels/[id]/analyze — [domain] authorization", () => {
  it("[www/non-www consistency] reuses isSameDomain from urlPolicy — never a separate/reimplemented comparison", () => {
    expect(source).toMatch(/import\s*\{[^}]*isSameDomain[^}]*\}\s*from\s*"@\/features\/crawler\/urlPolicy"/);
    expect(source).toMatch(/isSameDomain\(url,\s*hotel\.website\)/);
  });

  it("[domain mismatch -> refusal before crawl] the domain check runs before the consent check and before crawlWebsite()", () => {
    const domainCheckIndex = source.indexOf("isSameDomain(url, hotel.website)");
    const consentCheckIndex = source.indexOf("hasSiteAnalysisConsent(");
    const crawlIndex = source.indexOf("crawlWebsite(");
    expect(domainCheckIndex).toBeGreaterThan(-1);
    expect(consentCheckIndex).toBeGreaterThan(-1);
    expect(crawlIndex).toBeGreaterThan(-1);
    expect(domainCheckIndex).toBeLessThan(consentCheckIndex);
    expect(consentCheckIndex).toBeLessThan(crawlIndex);
  });

  it("rejects when hotel.website itself is missing, rather than skipping the domain check", () => {
    expect(source).toMatch(/if\s*\(!hotel\.website\)/);
  });
});
