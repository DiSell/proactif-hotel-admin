import { z } from "zod";

export const widgetSettingsSchema = z.object({
  position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]),
  icon: z.enum(["chat", "help", "message"]),
  welcome_message: z.string().trim().min(1, "Le message d’accueil est obligatoire."),
  is_active: z.boolean(),
});

export type WidgetSettingsInput = z.infer<typeof widgetSettingsSchema>;
