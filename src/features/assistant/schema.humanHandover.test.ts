import { describe, expect, it } from "vitest";
import { chatbotSettingsSchema } from "./schema";

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — Section 6/7: up to 3 SMS numbers,
 * E.164-validated server-side, all independently optional so a hotel can
 * still save its other assistant settings with none configured.
 */

function baseInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    welcome_message: "Bonjour !",
    fallback_message: "Je ne sais pas.",
    handoff_email: "",
    handoff_phone: "",
    tone: "warm",
    formality: "vous",
    response_length: "normal",
    commercial_proactivity: "discreet",
    custom_instructions: "",
    allow_price_communication: false,
    handover_sms_phone_primary: "",
    handover_sms_phone_secondary: "",
    handover_sms_phone_backup: "",
    ...overrides,
  };
}

describe("chatbotSettingsSchema — handover_sms_phone_* fields", () => {
  it("[tous vides] accepté — un hôtel peut enregistrer ses réglages sans aucun numéro configuré", () => {
    const result = chatbotSettingsSchema.safeParse(baseInput());
    expect(result.success).toBe(true);
  });

  it("[1 numéro valide] accepté", () => {
    const result = chatbotSettingsSchema.safeParse(baseInput({ handover_sms_phone_primary: "+33612345678" }));
    expect(result.success).toBe(true);
  });

  it("[3 numéros valides] acceptés", () => {
    const result = chatbotSettingsSchema.safeParse(
      baseInput({
        handover_sms_phone_primary: "+33612345678",
        handover_sms_phone_secondary: "+33612345679",
        handover_sms_phone_backup: "+33612345680",
      })
    );
    expect(result.success).toBe(true);
  });

  it("[format invalide] rejeté avec un message lisible", () => {
    const result = chatbotSettingsSchema.safeParse(baseInput({ handover_sms_phone_primary: "0612345678" }));
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "handover_sms_phone_primary");
      expect(issue?.message).toMatch(/invalide/i);
    }
  });

  it("[secondaire/backup vides mais primary rempli] accepté — optionnels indépendamment", () => {
    const result = chatbotSettingsSchema.safeParse(baseInput({ handover_sms_phone_primary: "+33612345678" }));
    expect(result.success).toBe(true);
  });
});
