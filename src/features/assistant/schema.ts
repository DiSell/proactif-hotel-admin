import { z } from "zod";

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — same E.164 shape already used
 * elsewhere in this codebase (serviceRequests/schema.ts's phoneE164,
 * sendPartnerRequestSms.ts's own E164_PATTERN, 0043/0048's own CHECK
 * constraints) — duplicated here rather than imported, same "no shared
 * cross-domain constant, no real cost to a few duplicated lines" precedent.
 */
const handoverSmsPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{7,14}$/, "Format invalide (ex. +33612345678).")
  .optional()
  .or(z.literal(""));

export const chatbotSettingsSchema = z.object({
  welcome_message: z.string().trim().min(1, "Le message d’accueil est obligatoire."),
  fallback_message: z.string().trim().min(1, "Le message de repli est obligatoire."),
  handoff_email: z.string().trim().email("Email invalide.").optional().or(z.literal("")),
  handoff_phone: z.string().trim().optional().or(z.literal("")),
  tone: z.enum(["professional", "warm", "elegant", "direct"]),
  formality: z.enum(["vous", "tu"]),
  response_length: z.enum(["short", "normal", "detailed"]),
  commercial_proactivity: z.enum(["disabled", "discreet", "proactive"]),
  custom_instructions: z.string().trim().optional().or(z.literal("")),
  allow_price_communication: z.boolean(),
  /**
   * HUMAN HANDOVER / RAPPEL SMS chantier — up to 3 SMS numbers a callback
   * request gets texted to. primary/secondary/backup, all independently
   * optional at the schema level (an hotel that hasn't configured any yet
   * must still be able to save its other settings) — see
   * features/rag/humanHandoverFlow.ts for what "no recipient configured"
   * actually degrades to for the visitor.
   */
  handover_sms_phone_primary: handoverSmsPhoneSchema,
  handover_sms_phone_secondary: handoverSmsPhoneSchema,
  handover_sms_phone_backup: handoverSmsPhoneSchema,
});

export type ChatbotSettingsInput = z.infer<typeof chatbotSettingsSchema>;
