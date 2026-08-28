import { describe, expect, it } from "vitest";
import { clientChatbotPersonalizationSchema, photoManagementModeSchema } from "./schema";

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
