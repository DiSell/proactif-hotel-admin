import { describe, expect, it } from "vitest";
import { clientChatbotPersonalizationSchema, clientHandoverSmsNumbersSchema, photoManagementModeSchema } from "./schema";

describe("clientChatbotPersonalizationSchema", () => {
  it("[valid] accepts a trimmed name and message", () => {
    const result = clientChatbotPersonalizationSchema.safeParse({ assistant_name: "Camille", welcome_message: "Bonjour !" });
    expect(result.success).toBe(true);
  });

  it("[no other fields accepted] the schema's shape has exactly assistant_name and welcome_message — structurally cannot carry system prompt/model/threshold/API keys/hotel_id", () => {
    expect(Object.keys(clientChatbotPersonalizationSchema.shape).sort()).toEqual(["assistant_name", "welcome_message"]);
  });

  it("[blank name rejected] an empty/whitespace assistant_name fails validation", () => {
    const result = clientChatbotPersonalizationSchema.safeParse({ assistant_name: "   ", welcome_message: "Bonjour !" });
    expect(result.success).toBe(false);
  });

  it("[blank message rejected] an empty/whitespace welcome_message fails validation", () => {
    const result = clientChatbotPersonalizationSchema.safeParse({ assistant_name: "Camille", welcome_message: "   " });
    expect(result.success).toBe(false);
  });
});

describe("photoManagementModeSchema", () => {
  it("[valid values] accepts exactly 'client' and 'proactif'", () => {
    expect(photoManagementModeSchema.safeParse("client").success).toBe(true);
    expect(photoManagementModeSchema.safeParse("proactif").success).toBe(true);
  });

  it("[invalid value rejected]", () => {
    expect(photoManagementModeSchema.safeParse("superadmin").success).toBe(false);
  });
});

/** HUMAN HANDOVER / RAPPEL SMS chantier — client-editable subset of chatbot_settings.handover_sms_phone_*. */
describe("clientHandoverSmsNumbersSchema", () => {
  it("[no other fields accepted] the schema's shape has exactly the 3 handover SMS fields — structurally cannot carry tone/formality/custom_instructions/hotel_id/any other chatbot_settings field", () => {
    expect(Object.keys(clientHandoverSmsNumbersSchema.shape).sort()).toEqual([
      "handover_sms_phone_backup",
      "handover_sms_phone_primary",
      "handover_sms_phone_secondary",
    ]);
  });

  it("[tous vides] accepté — un hôtelier peut enregistrer sans aucun numéro configuré", () => {
    const result = clientHandoverSmsNumbersSchema.safeParse({
      handover_sms_phone_primary: "",
      handover_sms_phone_secondary: "",
      handover_sms_phone_backup: "",
    });
    expect(result.success).toBe(true);
  });

  it("[1 numéro valide] accepté, secondaire/secours vides", () => {
    const result = clientHandoverSmsNumbersSchema.safeParse({
      handover_sms_phone_primary: "+33612345678",
      handover_sms_phone_secondary: "",
      handover_sms_phone_backup: "",
    });
    expect(result.success).toBe(true);
  });

  it("[3 numéros valides] acceptés", () => {
    const result = clientHandoverSmsNumbersSchema.safeParse({
      handover_sms_phone_primary: "+33612345678",
      handover_sms_phone_secondary: "+33612345679",
      handover_sms_phone_backup: "+33612345680",
    });
    expect(result.success).toBe(true);
  });

  it("[format invalide] rejeté avec un message lisible", () => {
    const result = clientHandoverSmsNumbersSchema.safeParse({
      handover_sms_phone_primary: "0612345678",
      handover_sms_phone_secondary: "",
      handover_sms_phone_backup: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "handover_sms_phone_primary");
      expect(issue?.message).toMatch(/invalide/i);
    }
  });

  it("[champ facultatif peut être vidé] un secondaire déjà rempli peut redevenir une chaîne vide", () => {
    const result = clientHandoverSmsNumbersSchema.safeParse({
      handover_sms_phone_primary: "+33612345678",
      handover_sms_phone_secondary: "",
      handover_sms_phone_backup: "+33612345680",
    });
    expect(result.success).toBe(true);
  });
});
