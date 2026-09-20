import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "TargetedPhotoImport.tsx"), "utf8");

/**
 * Source-level audit for TargetedPhotoImport — same constraint as every
 * other "use client" component test in this repo (no jsdom/RTL). Confirms
 * the STRUCTURAL guarantees the S2 mission required: nothing executes on
 * mount, an explicit click AND a confirmation are both required, and a
 * partial outcome (photosFailed > 0) is never presented as a blanket
 * success.
 */
describe("TargetedPhotoImport — no execution on mount", () => {
  it("[no useEffect, no top-level action call] the action is only ever invoked from inside the click handler", () => {
    expect(source).not.toMatch(/useEffect/);
    const actionCallIndex = source.indexOf("await action(hotelId)");
    expect(actionCallIndex).toBeGreaterThan(-1);
    const handlerStart = source.indexOf("function handleImportClick()");
    const handlerEnd = source.indexOf("\n  }", handlerStart);
    expect(actionCallIndex).toBeGreaterThan(handlerStart);
    expect(actionCallIndex).toBeLessThan(handlerEnd);
  });
});

describe("TargetedPhotoImport — explicit confirmation required before any call", () => {
  it("[window.confirm gates the action] a declined confirmation returns before startTransition/action is ever reached", () => {
    const handlerStart = source.indexOf("function handleImportClick()");
    const fn = source.slice(handlerStart, source.indexOf("\n  return (", handlerStart));
    const confirmIndex = fn.indexOf("window.confirm(");
    const guardIndex = fn.indexOf("if (!confirmed) return;");
    const transitionIndex = fn.indexOf("startTransition(");
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeGreaterThan(confirmIndex);
    expect(transitionIndex).toBeGreaterThan(guardIndex);
  });

  it("[button itself never bypasses confirmation] the visible button's onClick calls handleImportClick, never action() directly", () => {
    expect(source).toMatch(/onClick=\{handleImportClick\}/);
    expect(source).not.toMatch(/onClick=\{.*action\(hotelId\).*\}/);
  });
});

describe("TargetedPhotoImport — partial failure is never presented as a blanket success", () => {
  it("[danger toast on partial failure] photosFailed > 0 triggers a danger-toned toast, not a plain success one", () => {
    expect(source).toMatch(/if \(data && data\.photosFailed > 0\) \{/);
    expect(source).toMatch(/toast\.show\(`Import partiel : \$\{data\.photosFailed\} photo\(s\) en échec[^`]*`, "danger"\);/);
  });

  it("[result panel highlights failures] the failed-count line is visually distinguished (danger styling) when non-zero", () => {
    expect(source).toMatch(/className=\{result\.photosFailed > 0 \? "font-semibold text-danger" : undefined\}/);
  });

  it("[action-level error never silently swallowed] ok:false surfaces its own error message and clears any prior result", () => {
    const handlerStart = source.indexOf("function handleImportClick()");
    const fn = source.slice(handlerStart);
    const notOkIndex = fn.indexOf("if (!outcome.ok) {");
    expect(notOkIndex).toBeGreaterThan(-1);
    const notOkBlock = fn.slice(notOkIndex, fn.indexOf("return;", notOkIndex));
    expect(notOkBlock).toMatch(/setResult\(null\);/);
    expect(notOkBlock).toMatch(/setErrorMessage\(outcome\.error/);
  });
});

describe("TargetedPhotoImport — button disabled while pending, summary derived from the plan", () => {
  it("[disabled during import] the button is disabled while isPending, preventing a double-click from firing two calls", () => {
    expect(source).toMatch(/disabled=\{isPending\}/);
  });

  it("[summary/total sourced from targetedImportPlan.ts] never a separately hardcoded count in this file — true whether the plan holds 47, 58, or any future total", () => {
    expect(source).toMatch(/import \{ targetedImportSummary, targetedImportTotal \} from "\.\/targetedImportPlan";/);
    expect(source).not.toMatch(/\b47\b/);
    expect(source).not.toMatch(/\b58\b/);
  });
});
