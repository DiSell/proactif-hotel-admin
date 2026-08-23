import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "AnalyzeSiteModal.tsx"), "utf8");

/**
 * hasImportableContent() is the single source of truth behind the checkbox
 * `disabled` state, the "sélectionnable(s)" counter, and handleImport's
 * final filter — this file can't import the component directly (it's a
 * "use client" component pulling in next/navigation and a "use server"
 * actions module, both fragile to import outside Next's runtime), so the
 * regression guard here extracts the REAL current expression from the
 * source and evaluates it, rather than reimplementing the logic separately
 * and risking the two drifting apart silently.
 */
function extractHasImportableContent(): (status: string) => boolean {
  const match = source.match(/function hasImportableContent\([^)]*\)[^{]*\{[\s\S]*?return ([^;]+);[\s\S]*?\}/);
  expect(match).not.toBeNull();
  const expression = match![1];
  return new Function("status", `return ${expression};`) as (status: string) => boolean;
}

describe("AnalyzeSiteModal — selectable status rules", () => {
  it("[duplicate excluded] a CrawlPage with status=duplicate is never importable", () => {
    const hasImportableContent = extractHasImportableContent();
    expect(hasImportableContent("duplicate")).toBe(false);
  });

  it("only relevant and probably_technical are importable — every other status is excluded", () => {
    const hasImportableContent = extractHasImportableContent();
    expect(hasImportableContent("relevant")).toBe(true);
    expect(hasImportableContent("probably_technical")).toBe(true);
    expect(hasImportableContent("duplicate")).toBe(false);
    expect(hasImportableContent("insufficient_content")).toBe(false);
    expect(hasImportableContent("unreachable")).toBe(false);
    expect(hasImportableContent("robots_disallowed")).toBe(false);
  });

  it("[counter] 14 relevant + 1 probably_technical + 10 duplicate + 2 insufficient_content => 15 selectable", () => {
    const hasImportableContent = extractHasImportableContent();
    const statuses = [
      ...Array(14).fill("relevant"),
      ...Array(1).fill("probably_technical"),
      ...Array(10).fill("duplicate"),
      ...Array(2).fill("insufficient_content"),
    ];
    const selectableCount = statuses.filter(hasImportableContent).length;
    expect(selectableCount).toBe(15);
  });

  it("the checkbox disabled state and handleImport's filter both reuse hasImportableContent (single source of truth)", () => {
    const checkboxMatch = source.match(/disabled=\{!importable\}/);
    const importableDeclaration = source.match(/const importable = hasImportableContent\(page\.status\);/);
    const handleImportFilter = source.match(/selected\.has\(i\) && hasImportableContent\(p\.status\)/);
    expect(checkboxMatch).not.toBeNull();
    expect(importableDeclaration).not.toBeNull();
    expect(handleImportFilter).not.toBeNull();
  });

  it("the selectableCount counter also reuses hasImportableContent, not a separate reimplementation", () => {
    expect(source).toMatch(/pages\.filter\(\(p\) => hasImportableContent\(p\.status\)\)\.length/);
  });
});
