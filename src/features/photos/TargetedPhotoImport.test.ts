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

describe("TargetedPhotoImport — two-click in-page confirmation, no window.confirm", () => {
  it("[no window.confirm anywhere] a native dialog can be silently suppressed by the browser with zero feedback — replaced by in-page state", () => {
    expect(source).not.toMatch(/window\.confirm/);
  });

  it("[first click only arms, never calls the action] isArmed is set and the handler returns before startTransition is ever reached", () => {
    const handlerStart = source.indexOf("function handleImportClick()");
    const handlerBody = source.slice(handlerStart, source.indexOf("\n  }", handlerStart));
    const armIndex = handlerBody.indexOf("if (!isArmed) {");
    const setArmedIndex = handlerBody.indexOf("setIsArmed(true);", armIndex);
    const returnIndex = handlerBody.indexOf("return;", setArmedIndex);
    const transitionIndex = handlerBody.indexOf("startTransition(");
    expect(armIndex).toBeGreaterThan(-1);
    expect(setArmedIndex).toBeGreaterThan(armIndex);
    expect(returnIndex).toBeGreaterThan(setArmedIndex);
    expect(transitionIndex).toBeGreaterThan(returnIndex);
  });

  it("[second click disarms and calls the action] setIsArmed(false) happens before startTransition, action(hotelId) happens inside it", () => {
    const handlerStart = source.indexOf("function handleImportClick()");
    const handlerBody = source.slice(handlerStart, source.indexOf("\n  }", handlerStart));
    const disarmIndex = handlerBody.indexOf("setIsArmed(false);");
    const transitionIndex = handlerBody.indexOf("startTransition(");
    const actionCallIndex = handlerBody.indexOf("await action(hotelId)");
    expect(disarmIndex).toBeGreaterThan(-1);
    expect(disarmIndex).toBeLessThan(transitionIndex);
    expect(actionCallIndex).toBeGreaterThan(transitionIndex);
  });

  it("[button label reflects the armed/pending state]", () => {
    expect(source).toMatch(/isPending \? "Import en cours…" : isArmed \? `Confirmer l'import des \$\{total\} photos` : `Importer les \$\{total\} photos`/);
  });

  it("[explicit in-page hint shown only while armed and not pending — states clearly that a second click is required]", () => {
    expect(source).toMatch(/\{isArmed && !isPending && \(/);
  });

  it("[obsolete '5 catégories' text corrected to the plan's real 7 categories]", () => {
    expect(source).not.toMatch(/5 catégories/);
    expect(source).toMatch(/7 catégories/);
  });

  it("[button itself never bypasses the two-click gate] the visible button's onClick calls handleImportClick, never action() directly", () => {
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
