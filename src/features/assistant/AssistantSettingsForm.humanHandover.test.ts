import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "AssistantSettingsForm.tsx"), "utf8");

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — Section 7: extends the EXISTING
 * AssistantSettingsForm.tsx screen (no new screen), exact UX text from the
 * mission spec. Same DOM-less, source-level discipline as every other
 * *.test.ts file for this form's sibling components in this repo.
 */
describe("AssistantSettingsForm — section 'Demandes de rappel par SMS'", () => {
  it("[section heading + explanatory text, verbatim from the mission spec]", () => {
    expect(source).toContain("Demandes de rappel par SMS");
    expect(source).toContain(
      "Lorsqu’un visiteur demande à être contacté par un membre de l’établissement, la demande peut être envoyée par SMS aux numéros configurés."
    );
  });

  it("[3 labels, verbatim from the mission spec]", () => {
    expect(source).toContain("Numéro principal");
    expect(source).toContain("Numéro secondaire (facultatif)");
    expect(source).toContain("Numéro de secours (facultatif)");
  });

  it("[3 state fields wired into SaveAssistantSettingsInput, initialized from existing settings]", () => {
    expect(source).toMatch(/handover_sms_phone_primary: settings\?\.handover_sms_phone_primary \?\? ""/);
    expect(source).toMatch(/handover_sms_phone_secondary: settings\?\.handover_sms_phone_secondary \?\? ""/);
    expect(source).toMatch(/handover_sms_phone_backup: settings\?\.handover_sms_phone_backup \?\? ""/);
  });

  it("[never displays a Twilio secret] no TWILIO/secret/token/sid text anywhere in this form]", () => {
    expect(source).not.toMatch(/twilio|auth_token|account_sid/i);
  });
});
