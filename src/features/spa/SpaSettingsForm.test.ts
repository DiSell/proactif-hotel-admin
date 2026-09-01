import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "SpaSettingsForm.tsx"), "utf8");

describe("SpaSettingsForm — visible captions next to every toggle", () => {
  it("[Toggle's own label prop is aria-label only (see components/ui/Toggle.tsx) — every toggle here has an adjacent visible <span>, same lesson as EventFormModal's own fixed bug]", () => {
    const toggleBlocks = source.match(/<Toggle[^]*?<\/div>/g) ?? [];
    expect(toggleBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of toggleBlocks) {
      expect(block).toMatch(/<span className="text-xs text-ink">/);
    }
  });
});

describe("SpaSettingsForm — submission", () => {
  it("[calls upsertHotelSpaSettingsClient with the current form state]", () => {
    const fn = source.slice(source.indexOf("function handleSubmit"), source.indexOf("return ("));
    expect(fn).toMatch(/await upsertHotelSpaSettingsClient\(hotelId, form\)/);
  });

  it("[field errors are surfaced back into state]", () => {
    expect(source).toMatch(/setErrors\(result\.fieldErrors \?\? \{\}\)/);
  });
});

describe("SpaSettingsForm — price_per_person nullable handling", () => {
  it("[an empty price field is submitted as null, never NaN or an empty string]", () => {
    expect(source).toMatch(/event\.target\.value === "" \? null : Number\(event\.target\.value\)/);
  });
});

describe("SpaSettingsForm — no fixed slot duration assumed", () => {
  it("[slot duration is a plain editable number field, never a hardcoded value]", () => {
    expect(source).not.toMatch(/value=\{120\}/);
    expect(source).toMatch(/value=\{form\.slot_duration_minutes\}/);
  });
});
