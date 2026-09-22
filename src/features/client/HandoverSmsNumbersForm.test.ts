import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "HandoverSmsNumbersForm.tsx"), "utf8");

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — client-portal exposure. Same
 * DOM-less, source-level discipline as every other client-portal component
 * test in this repo (no jsdom).
 */
describe("HandoverSmsNumbersForm — affiche les 3 numéros actuels", () => {
  it("[initialisé depuis les props, jamais recalculé côté client]", () => {
    expect(source).toMatch(/handover_sms_phone_primary: initialPrimary,/);
    expect(source).toMatch(/handover_sms_phone_secondary: initialSecondary,/);
    expect(source).toMatch(/handover_sms_phone_backup: initialBackup,/);
  });

  it("[3 champs exactement, labels verbatim du mandat]", () => {
    expect(source).toContain("Numéro principal");
    expect(source).toContain("Numéro secondaire (facultatif)");
    expect(source).toContain("Numéro de secours (facultatif)");
  });

  it("[texte explicatif verbatim du mandat]", () => {
    expect(source).toContain(
      "Ces numéros reçoivent les demandes de rappel transmises par le chatbot. Vous pouvez renseigner jusqu’à 3 numéros."
    );
  });
});

describe("HandoverSmsNumbersForm — enregistrement via l'action client dédiée", () => {
  it("[appelle updateHandoverSmsNumbers, jamais saveAssistantSettings/le chemin superadmin]", () => {
    expect(source).toMatch(/import \{ updateHandoverSmsNumbers \} from "\.\/actions";/);
    expect(source).toMatch(/await updateHandoverSmsNumbers\(state\);/);
    expect(source).not.toMatch(/saveAssistantSettings/);
    expect(source).not.toMatch(/requireSuperadmin/);
  });

  it("[jamais un champ superadmin exposé] ne référence aucun des champs superadmin-only de chatbot_settings", () => {
    expect(source).not.toMatch(/\btone\b|\bformality\b|response_length|commercial_proactivity|custom_instructions|fallback_message|handoff_email|handoff_phone/);
  });
});
