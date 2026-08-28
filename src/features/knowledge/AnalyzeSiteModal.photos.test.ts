import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "AnalyzeSiteModal.tsx"), "utf8");

/**
 * Regression guards for the photo-curation UI rewrite (uncapped photos,
 * inclusion decoupled from photo selection, explicit Tout sélectionner/
 * désélectionner). Same testing constraint as
 * AnalyzeSiteModal.selection.test.ts (a "use client" component, fragile to
 * import outside Next's runtime) — checked at the source level. The
 * underlying pure logic (buildAccommodationGroups/buildAccommodationTypesPayload)
 * is exercised directly, with real assertions on real return values, in
 * accommodationGrouping.test.ts — this file only guards that the component
 * actually wires up to that logic correctly.
 */
describe("AnalyzeSiteModal — photo cap removed", () => {
  it("[no cap import] PHOTOS_PER_ACCOMMODATION_CAP is never imported or referenced — every distinct detected photo is shown", () => {
    expect(source).not.toMatch(/PHOTOS_PER_ACCOMMODATION_CAP/);
  });

  it("[no hiddenPhotoCount] the 'masquée(s)' hidden-photos notice is gone along with the cap", () => {
    expect(source).not.toMatch(/hiddenPhotoCount/);
  });
});

describe("AnalyzeSiteModal — inclusion decoupled from photo selection", () => {
  it("[includedGroupKeys state exists, independent of checkedPhotoKeys]", () => {
    expect(source).toMatch(/const \[includedGroupKeys, setIncludedGroupKeys\] = useState<Set<string>>\(new Set\(\)\);/);
  });

  it("[auto-included on detection] a fresh analysis seeds includedGroupKeys/checkedPhotoKeys from every detected group — 'Proactif détecte et prépare automatiquement' — computed synchronously in handleAnalyze, never in a useEffect reacting after the fact", () => {
    expect(source).not.toMatch(/useEffect\(/);
    expect(source.match(/^import \{[^}]*\} from "react";/m)?.[0]).not.toMatch(/useEffect/);
    expect(source).toMatch(/setIncludedGroupKeys\(new Set\(freshGroups\.map\(\(group\) => group\.key\)\)\);/);
    expect(source).toMatch(/setCheckedPhotoKeys\(new Set\(freshGroups\.flatMap\(\(group\) => group\.photos\.map\(\(photo\) => photo\.key\)\)\)\);/);
  });

  it("[payload call passes includedGroupKeys] buildAccommodationTypesPayload is called with the new inclusion field, not just checkedPhotoKeys", () => {
    expect(source).toMatch(/buildAccommodationTypesPayload\(accommodationGroups, \{\s*includedGroupKeys,\s*checkedPhotoKeys,/);
  });
});

describe("AnalyzeSiteModal — explicit Tout sélectionner / Tout désélectionner", () => {
  it("[selectAllPhotos adds every photo in the group]", () => {
    const fn = source.slice(source.indexOf("function selectAllPhotos"), source.indexOf("function deselectAllPhotos"));
    expect(fn).toMatch(/for \(const photo of group\.photos\) next\.add\(photo\.key\);/);
  });

  it("[deselectAllPhotos removes every photo in the group]", () => {
    const fn = source.slice(source.indexOf("function deselectAllPhotos"), source.indexOf("const confirmedAccommodations"));
    expect(fn).toMatch(/for \(const photo of group\.photos\) next\.delete\(photo\.key\);/);
  });

  it("[two distinct buttons rendered] 'Tout sélectionner' and 'Tout désélectionner' are separate JSX buttons, on top of individual photo clicks (togglePhoto)", () => {
    expect(source).toMatch(/onClick=\{\(\) => selectAllPhotos\(group\)\}/);
    expect(source).toMatch(/onClick=\{\(\) => deselectAllPhotos\(group\)\}/);
    expect(source).toMatch(/onChange=\{\(\) => togglePhoto\(group, photo\.key\)\}/);
  });

  it("[inclusion checkbox is separate from the select-all/deselect-all buttons] toggleGroupIncluded only flips includedGroupKeys, never touches checkedPhotoKeys", () => {
    const fn = source.slice(source.indexOf("function toggleGroupIncluded"), source.indexOf("function togglePhoto"));
    expect(fn).not.toMatch(/checkedPhotoKeys/);
  });
});
