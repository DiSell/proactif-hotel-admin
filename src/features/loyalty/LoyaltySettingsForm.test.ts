import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "LoyaltySettingsForm.tsx"), "utf8");

describe("LoyaltySettingsForm — subject belongs to the whole email, not the thank-you block", () => {
  it("[the subject input is positioned before the 'Remerciement' block, never nested inside it]", () => {
    const subjectInputIndex = source.indexOf('value={subject} onChange={(event) => setSubject(event.target.value)}');
    const remerciementHeadingIndex = source.indexOf(">Remerciement<");
    expect(subjectInputIndex).toBeGreaterThan(-1);
    expect(remerciementHeadingIndex).toBeGreaterThan(-1);
    expect(subjectInputIndex).toBeLessThan(remerciementHeadingIndex);
  });

  it("[the subject field's own label never says it belongs to the thank-you block]", () => {
    expect(source).toMatch(/Objet de l&rsquo;email/);
  });
});

describe("LoyaltySettingsForm — preview never masks an invalid review button label", () => {
  it("[no silent '\"Laisser un avis\"' fallback — the server would reject an empty review_button_label]", () => {
    expect(source).not.toMatch(/reviewButtonLabel \|\| "Laisser un avis"/);
  });

  it("[the button preview only renders once reviewButtonLabel is genuinely non-empty]", () => {
    expect(source).toMatch(/reviewUrl && reviewButtonLabel\.trim\(\) &&/);
  });

  it("[an empty button label surfaces a visible validation hint in the preview instead]", () => {
    expect(source).toMatch(/!reviewButtonLabel\.trim\(\)/);
    expect(source).toMatch(/Indiquez un libellé de bouton/);
  });
});
