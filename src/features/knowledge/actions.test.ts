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
 * AJOUTER UNE URL chantier — addUrlSource/reindexSource are Supabase- AND
 * network-touching (requireSuperadmin, createClient, revalidatePath via
 * importCrawledPages), same testing constraint as every other action in
 * this file — checked at the source level. The pure fetch+extract logic
 * itself (fetchPageContent's own branching on safeFetch/extractPage
 * results) is real-invocation tested separately in
 * features/crawler/fetchPage.test.ts, where no Supabase/session/
 * revalidatePath dependency exists.
 */
describe("addUrlSource — fetches for real, never a stray content=NULL row", () => {
  function sliceFunction(exportedName: string): string {
    const start = source.indexOf(`export async function ${exportedName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport async function", start + 1);
    return source.slice(start, nextExport === -1 ? undefined : nextExport);
  }

  it("[fetches before writing] calls fetchPageContent before any knowledge_sources write is attempted", () => {
    const fn = sliceFunction("addUrlSource");
    const fetchIndex = fn.indexOf("await fetchPageContent(");
    const importIndex = fn.indexOf("importCrawledPages(");
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(importIndex).toBeGreaterThan(fetchIndex);
  });

  it("[no row on fetch failure] a failed fetch returns an error before importCrawledPages is ever reached — no stray content=NULL/status=error row is created for an unreachable page", () => {
    const fn = sliceFunction("addUrlSource");
    const fetchIndex = fn.indexOf("await fetchPageContent(");
    const guardIndex = fn.indexOf("if (!fetched.ok)", fetchIndex);
    const importIndex = fn.indexOf("importCrawledPages(", fetchIndex);
    expect(guardIndex).toBeGreaterThan(fetchIndex);
    expect(guardIndex).toBeLessThan(importIndex);
    const guardBlock = fn.slice(guardIndex, importIndex);
    expect(guardBlock).toMatch(/return \{ ok: false, error: FETCH_ERROR_MESSAGES\[fetched\.errorReason\] \};/);
    expect(guardBlock).not.toMatch(/\.insert\(|\.from\("knowledge_sources"\)/);
  });

  it("[delegates the write to importCrawledPages, never a second upsert/anti-dup implementation] the real fetched content is passed straight through, never re-derived", () => {
    const fn = sliceFunction("addUrlSource");
    expect(fn).toMatch(/importCrawledPages\(hotelId, \{/);
    expect(fn).toMatch(/finalUrl: fetched\.finalUrl, title: parsed\.data\.title, content: fetched\.content, language: null/);
    // No independent .from("knowledge_sources").insert/.update anywhere in this function — insertSource is a different function, never called here.
    expect(fn).not.toMatch(/insertSource\(/);
  });

  it("[title never silently rewritten] language is deliberately passed as null so importCrawledPages's own auto-suffix logic never edits the admin's typed title", () => {
    const fn = sliceFunction("addUrlSource");
    expect(fn).toMatch(/language: null/);
  });

  it("[still superadmin-gated, still session-bound] requireSuperadmin and createClient (never createAdminClient/service_role) are still used", () => {
    const fn = sliceFunction("addUrlSource");
    expect(fn).toMatch(/await requireSuperadmin\(\);/);
    expect(fn).toMatch(/await createClient\(\);/);
    expect(fn).not.toMatch(/createAdminClient|service_role/i);
  });
});

describe("reindexSource — type \"url\" re-fetches for real, other types unchanged", () => {
  function sliceFunction(exportedName: string): string {
    const start = source.indexOf(`export async function ${exportedName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport async function", start + 1);
    return source.slice(start, nextExport === -1 ? undefined : nextExport);
  }

  it("[type url branch] calls fetchPageContent with the EXISTING source_url, before ingestSource", () => {
    const fn = sliceFunction("reindexSource");
    const branchIndex = fn.indexOf('source.type === "url"');
    const fetchIndex = fn.indexOf("await fetchPageContent(source.source_url", branchIndex);
    const ingestIndex = fn.indexOf("await ingestSource(hotelId, sourceId);", branchIndex);
    expect(branchIndex).toBeGreaterThan(-1);
    expect(fetchIndex).toBeGreaterThan(branchIndex);
    expect(fetchIndex).toBeLessThan(ingestIndex);
  });

  it("[reuses the existing row, never a duplicate] on refetch success, updates content on the SAME sourceId — no .insert( anywhere in this function", () => {
    const fn = sliceFunction("reindexSource");
    expect(fn).toMatch(/\.update\(\{ content: fetched\.content, status: "pending" \}\)\.eq\("id", sourceId\)/);
    expect(fn).not.toMatch(/\.insert\(/);
  });

  it("[refetch failure marks the existing row error, keeps its previous content untouched] never silently keeps a stale 'indexed' status", () => {
    const fn = sliceFunction("reindexSource");
    const branchIndex = fn.indexOf('source.type === "url"');
    const fetchFailureIndex = fn.indexOf("if (!fetched.ok)", branchIndex);
    const errorUpdateIndex = fn.indexOf('.update({ status: "error" })', fetchFailureIndex);
    expect(errorUpdateIndex).toBeGreaterThan(fetchFailureIndex);
    // That error-marking update is scoped to THIS sourceId, never a bulk update.
    const line = fn.slice(errorUpdateIndex, fn.indexOf(";", errorUpdateIndex));
    expect(line).toMatch(/\.eq\("id", sourceId\)/);
  });

  it("[non-url types unchanged] the else branch never calls fetchPageContent — same two-line behavior as before this chantier", () => {
    const fn = sliceFunction("reindexSource");
    const elseIndex = fn.indexOf("} else {");
    const ingestIndex = fn.indexOf("const ingestResult = await ingestSource", elseIndex);
    const elseBlock = fn.slice(elseIndex, ingestIndex);
    expect(elseBlock).not.toMatch(/fetchPageContent/);
    expect(elseBlock).toMatch(/\.update\(\{ status: "pending" \}\)\.eq\("id", sourceId\)/);
  });

  it("[generic — no hotel-specific branch] no hardcoded hotel id, source id, or URL anywhere in this function", () => {
    const fn = sliceFunction("reindexSource");
    expect(fn).not.toMatch(/a675cb48|674ee588|le1837/i);
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

  it("[is_selected persisted per photo] room_photos.is_selected is written straight from photo.isSelected — never forced true/false regardless of curation-time state", () => {
    const fn = sliceFunction("saveAccommodationTypes");
    expect(fn).toMatch(/is_selected:\s*photo\.isSelected/);
  });

  it("[0-photo accommodation_type saveable] the accommodation_types insert/update is never gated on accommodation.photos.length — a group with zero photos still creates/updates its row, only the photo for-loop below has nothing to iterate", () => {
    const fn = sliceFunction("saveAccommodationTypes");
    const accommodationTypeSection = fn.slice(0, fn.indexOf("for (let position"));
    expect(accommodationTypeSection).not.toMatch(/photos\.length/);
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
