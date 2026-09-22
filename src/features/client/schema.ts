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

/**
 * The ONE chatbot_settings field a hotel_admin may write themselves — see
 * features/client/actions.ts:setAllowPriceCommunication. Deliberately not
 * reusing/extending chatbotSettingsSchema (features/assistant/schema.ts,
 * superadmin-only): this is a single boolean, never a gateway to the rest
 * of that broader, superadmin-reserved settings surface.
 */
export const allowPriceCommunicationSchema = z.boolean();

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — the 3 chatbot_settings.handover_sms_phone_*
 * columns (0048_hotel_service_request_handover_sms.sql) a hotel_admin may
 * write themselves. Same E.164 shape as features/assistant/schema.ts's own
 * handoverSmsPhoneSchema (superadmin) — duplicated here rather than
 * imported, same "the client-editable subset is deliberately its own,
 * narrow schema, never a gateway to the rest of chatbotSettingsSchema"
 * precedent already established by clientChatbotPersonalizationSchema/
 * allowPriceCommunicationSchema above.
 */
const handoverSmsPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{7,14}$/, "Format invalide (ex. +33612345678).")
  .optional()
  .or(z.literal(""));

export const clientHandoverSmsNumbersSchema = z.object({
  handover_sms_phone_primary: handoverSmsPhoneSchema,
  handover_sms_phone_secondary: handoverSmsPhoneSchema,
  handover_sms_phone_backup: handoverSmsPhoneSchema,
});
export type ClientHandoverSmsNumbersInput = z.infer<typeof clientHandoverSmsNumbersSchema>;
