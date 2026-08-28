import { z } from "zod";

/**
 * The client-editable subset of chatbot personalization — deliberately
 * narrow. Structurally cannot touch the system prompt, security
 * instructions, OpenAI model, RAG threshold, API keys, hotel_id, or any
 * other chatbot_settings field (fallback_message, handoff, tone,
 * formality, response_length, commercial_proactivity,
 * custom_instructions — see features/assistant/schema.ts's broader
 * chatbotSettingsSchema, which is superadmin-only and never reused here).
 */
export const clientChatbotPersonalizationSchema = z.object({
  assistant_name: z.string().trim().min(1, "Donnez un nom à l’assistant.").max(60, "Nom trop long (60 caractères maximum)."),
  welcome_message: z
    .string()
    .trim()
    .min(1, "Le message d’accueil est obligatoire.")
    .max(500, "Message trop long (500 caractères maximum)."),
});
export type ClientChatbotPersonalizationInput = z.infer<typeof clientChatbotPersonalizationSchema>;

/** "Camille" — the example default name given in the product spec; a client who never customizes it still gets a named assistant, never a bare "Assistant". */
export const DEFAULT_ASSISTANT_NAME = "Camille";

export const photoManagementModeSchema = z.enum(["client", "proactif"]);
export type PhotoManagementMode = z.infer<typeof photoManagementModeSchema>;
