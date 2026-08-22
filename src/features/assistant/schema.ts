import { z } from "zod";

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
});

export type ChatbotSettingsInput = z.infer<typeof chatbotSettingsSchema>;
