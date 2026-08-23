import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * Regression guard for point A of the crawler identity fix: importing
 * touches Supabase, so it can't be unit-tested directly here (same
 * constraint as similarityThreshold.test.ts / answer.groundingMode.test.ts)
 * — this checks the source-level shape instead.
 */
describe("importCrawledPages — [2] source_url identity", () => {
  it("builds source_url from finalUrl (normalized), never from canonicalUrl", () => {
    const fn = source.slice(source.indexOf("export async function importCrawledPages"));
    expect(fn).toMatch(/normalizeUrl\(page\.finalUrl\)/);
    expect(fn).not.toMatch(/page\.canonicalUrl/);
    expect(fn).not.toMatch(/source_url:\s*page\.url\b/);
  });

  it("dedupes selected pages by normalized finalUrl before the upsert loop runs", () => {
    const fn = source.slice(source.indexOf("export async function importCrawledPages"));
    const dedupeIndex = fn.search(/seenSourceUrls/);
    const loopIndex = fn.indexOf("for (const page of uniquePages)");
    expect(dedupeIndex).toBeGreaterThan(-1);
    expect(loopIndex).toBeGreaterThan(-1);
    // The dedupe pass must run BEFORE the upsert loop, not inside/after it.
    expect(dedupeIndex).toBeLessThan(loopIndex);
  });
});

/**
 * Regression guards for saveAccommodationTypes — Supabase/network-touching,
 * same testing constraint as above — checked at the source level.
 */
describe("saveAccommodationTypes", () => {
  function sliceFunction(exportedName: string): string {
    const start = source.indexOf(`export async function ${exportedName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport async function", start + 1);
    return source.slice(start, nextExport === -1 ? undefined : nextExport);
  }

  it("[SSRF] downloads photos through safeFetchBinary — never a raw fetch of an untrusted crawled URL", () => {
    const fn = sliceFunction("saveAccommodationTypes");
    expect(fn).toMatch(/safeFetchBinary\(photo\.imageUrl\)/);
  });

  it("[dedup] checks content_hash before uploading, and skips (never re-inserts) an already-imported photo", () => {
    const fn = sliceFunction("saveAccommodationTypes");
    const dedupCheckIndex = fn.indexOf('.eq("content_hash", fetched.contentHash)');
    const uploadIndex = fn.indexOf(".storage");
    expect(dedupCheckIndex).toBeGreaterThan(-1);
    expect(uploadIndex).toBeGreaterThan(-1);
    expect(dedupCheckIndex).toBeLessThan(uploadIndex);
    expect(fn).toMatch(/photosSkippedDuplicate\+\+/);
  });

  it("[no invented capacity] passes maxGuests straight through from the (validated) input, never derives or defaults it", () => {
    const fn = sliceFunction("saveAccommodationTypes");
    expect(fn).toMatch(/max_guests:\s*accommodation\.maxGuests/);
    expect(fn).not.toMatch(/max_guests:\s*accommodation\.maxGuests\s*\?\?/);
  });

  it("[partial failure isolation] a failed photo download or upload increments photosFailed and continues, never aborts the whole batch", () => {
    const fn = sliceFunction("saveAccommodationTypes");
    expect(fn).toMatch(/photosFailed\+\+/);
    // At least the download-rejection and upload-failure paths both `continue` rather than throw/return.
    const continueCount = (fn.match(/continue;/g) ?? []).length;
    expect(continueCount).toBeGreaterThanOrEqual(3);
  });

  it("[tenant isolation] every write is scoped to hotelId — never trusts a hotel_id implied by the input alone", () => {
    const fn = sliceFunction("saveAccommodationTypes");
    expect(fn).toMatch(/hotel_id:\s*hotelId/);
    expect(fn).toMatch(/\.eq\("hotel_id", hotelId\)/);
  });
});

/**
 * Regression guards for the consent-history redesign: Supabase-touching,
 * same testing constraint as above — checked at the source level.
 */
describe("site analysis consent — history preserved", () => {
  function sliceFunction(exportedName: string): string {
    const start = source.indexOf(`export async function ${exportedName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport async function", start + 1);
    return source.slice(start, nextExport === -1 ? undefined : nextExport);
  }

  it("[version N vs N+1] hasSiteAnalysisConsent checks consent_version === CURRENT_CONSENT_VERSION", () => {
    const fn = sliceFunction("hasSiteAnalysisConsent");
    expect(fn).toMatch(/\.eq\(\s*"consent_version",\s*CURRENT_CONSENT_VERSION\s*\)/);
  });

  it("[revoked] hasSiteAnalysisConsent also requires revoked_at IS NULL", () => {
    const fn = sliceFunction("hasSiteAnalysisConsent");
    expect(fn).toMatch(/\.is\(\s*"revoked_at",\s*null\s*\)/);
  });

  it("[history preserved] confirmSiteAnalysisConsent always INSERTs a new row, never upserts/updates an existing one", () => {
    const fn = sliceFunction("confirmSiteAnalysisConsent");
    expect(fn).toMatch(/\.insert\(/);
    expect(fn).not.toMatch(/\.upsert\(/);
    expect(fn).not.toMatch(/\.update\(/);
    // The exact accepted text is stored, not just the version tag.
    expect(fn).toMatch(/consent_text:\s*SITE_ANALYSIS_CONSENT_TEXT/);
  });

  it("[history preserved after revocation] revokeSiteAnalysisConsent UPDATEs revoked_at, never DELETEs the row", () => {
    const fn = sliceFunction("revokeSiteAnalysisConsent");
    expect(fn).toMatch(/\.update\(\s*\{\s*revoked_at:/);
    expect(fn).not.toMatch(/\.delete\(/);
    // Only touches currently-active rows — never re-revokes an already-revoked historical row.
    expect(fn).toMatch(/\.is\(\s*"revoked_at",\s*null\s*\)/);
  });
});
