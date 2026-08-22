import { z } from "zod";

const LANGUAGE_OPTIONS = ["fr", "en", "es", "nl", "de", "it"] as const;

export const hotelInfoSchema = z.object({
  name: z.string().trim().min(1, "Le nom est obligatoire."),
  website: z.string().trim().url("Entrez une URL valide (https://…)."),
  address: z.string().trim().optional().or(z.literal("")),
  postal_code: z.string().trim().optional().or(z.literal("")),
  city: z.string().trim().optional().or(z.literal("")),
  country: z.string().trim().optional().or(z.literal("")),
  phone: z.string().trim().optional().or(z.literal("")),
  email: z
    .string()
    .trim()
    .email("Entrez un email valide.")
    .optional()
    .or(z.literal("")),
});

export const hotelIdentitySchema = z.object({
  primary_color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Couleur invalide (format #RRGGBB)."),
  secondary_color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Couleur invalide (format #RRGGBB)."),
});

export const hotelLanguagesSchema = z
  .object({
    languages: z.array(z.enum(LANGUAGE_OPTIONS)).min(1, "Sélectionnez au moins une langue."),
    default_language: z.enum(LANGUAGE_OPTIONS),
    booking_url: z.string().trim().url("Entrez une URL valide.").optional().or(z.literal("")),
    spa_booking_url: z.string().trim().url("Entrez une URL valide.").optional().or(z.literal("")),
  })
  .refine((data) => data.languages.includes(data.default_language), {
    message: "La langue par défaut doit faire partie des langues sélectionnées.",
    path: ["default_language"],
  });

export const hotelAssistantIntroSchema = z.object({
  assistant_enabled: z.boolean(),
  assistant_name: z.string().trim().min(1, "Donnez un nom à l’assistant."),
  welcome_message: z.string().trim().min(1, "Le message d’accueil est obligatoire."),
});

export const createHotelSchema = z
  .object({})
  .merge(hotelInfoSchema)
  .merge(hotelIdentitySchema)
  .merge(hotelLanguagesSchema)
  .merge(hotelAssistantIntroSchema);

export type CreateHotelInput = z.infer<typeof createHotelSchema>;

export const updateHotelInfoSchema = hotelInfoSchema.merge(hotelIdentitySchema);
export type UpdateHotelInfoInput = z.infer<typeof updateHotelInfoSchema>;

export { LANGUAGE_OPTIONS };
