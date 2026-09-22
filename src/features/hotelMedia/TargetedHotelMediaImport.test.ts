import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "TargetedHotelMediaImport.tsx"), "utf8");

/**
 * Source-level audit for TargetedHotelMediaImport — mirrors
 * features/photos/TargetedPhotoImport.test.ts exactly (same two-click
 * arm/confirm UX, same guarantees), adapted for hotel_media's own action
 * and result shape (no accommodationTypesUpdated/Created — hotel_media has
 * no "types" table, only a fixed category enum).
 */
describe("TargetedHotelMediaImport — no execution on mount", () => {
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

describe("TargetedHotelMediaImport — two-click in-page confirmation, no window.confirm", () => {
  it("[no window.confirm anywhere]", () => {
    expect(source).not.toMatch(/window\.confirm/);
  });

  it("[first click only arms, never calls the action]", () => {
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

  it("[second click disarms and calls the action]", () => {
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

  it("[explicit in-page hint shown only while armed and not pending]", () => {
    expect(source).toMatch(/\{isArmed && !isPending && \(/);
  });

  it("[button itself never bypasses the two-click gate]", () => {
    expect(source).toMatch(/onClick=\{handleImportClick\}/);
    expect(source).not.toMatch(/onClick=\{.*action\(hotelId\).*\}/);
  });
});

describe("TargetedHotelMediaImport — partial failure is never presented as a blanket success", () => {
  it("[danger toast on partial failure]", () => {
    expect(source).toMatch(/if \(data && data\.photosFailed > 0\) \{/);
    expect(source).toMatch(/toast\.show\(`Import partiel : \$\{data\.photosFailed\} photo\(s\) en échec[^`]*`, "danger"\);/);
  });

  it("[result panel highlights failures]", () => {
    expect(source).toMatch(/className=\{result\.photosFailed > 0 \? "font-semibold text-danger" : undefined\}/);
  });

  it("[action-level error never silently swallowed]", () => {
    const handlerStart = source.indexOf("function handleImportClick()");
    const fn = source.slice(handlerStart);
    const notOkIndex = fn.indexOf("if (!outcome.ok) {");
    expect(notOkIndex).toBeGreaterThan(-1);
    const notOkBlock = fn.slice(notOkIndex, fn.indexOf("return;", notOkIndex));
    expect(notOkBlock).toMatch(/setResult\(null\);/);
    expect(notOkBlock).toMatch(/setErrorMessage\(outcome\.error/);
  });
});

describe("TargetedHotelMediaImport — button disabled while pending, summary/total derived from the plan", () => {
  it("[disabled during import]", () => {
    expect(source).toMatch(/disabled=\{isPending\}/);
  });

  it("[summary/total sourced from targetedImportPlan.ts] never a separately hardcoded count in this file", () => {
    expect(source).toMatch(/import \{ targetedHotelMediaImportSummary, targetedHotelMediaImportTotal \} from "\.\/targetedImportPlan";/);
    expect(source).not.toMatch(/\b58\b/);
  });

  it("[category labels reused from schema.ts, never a second label map]", () => {
    expect(source).toMatch(/import \{ HOTEL_MEDIA_CATEGORY_LABEL \} from "\.\/schema";/);
  });
});

describe("TargetedHotelMediaImport — aucune régression room_photos / PhotosManager", () => {
  it("[ce fichier ne référence jamais room_photos ni accommodation_types]", () => {
    expect(source).not.toMatch(/room_photos/);
    expect(source).not.toMatch(/accommodation_types/);
  });
});
