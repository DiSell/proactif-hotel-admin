import { z } from "zod";

const LANGUAGE_OPTIONS = ["fr", "en", "es", "nl", "de", "it"] as const;

const HTTP_URL_MESSAGE = "Entrez une URL valide commençant par http:// ou https://.";

/**
 * z.string().url() alone accepts ANY syntactically valid URL, including
 * javascript:, data:, and file: — all of which would end up rendered as a
 * plain <a href> in the chat widget (see RoomPhotoModal.tsx). Booking links
 * are the one URL a visitor's browser actually navigates to unattended, so
 * this restricts them to http/https specifically, not just "looks like a
 * URL".
 */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

const httpUrlSchema = z.string().trim().refine(isHttpUrl, { message: HTTP_URL_MESSAGE });

/** Shared by the creation wizard (hotelLanguagesShape) and hotel-info editing (updateHotelInfoSchema) — same column, same rules, both places. */
const hotelBookingLinksSchema = z.object({
  booking_url: httpUrlSchema.optional().or(z.literal("")),
  spa_booking_url: httpUrlSchema.optional().or(z.literal("")),
});

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

// Plain shape (no refine) so it stays mergeable — zod v4 forbids .merge()
// on a schema that already carries a .refine(). The cross-field check is
// applied once, at the end, on whichever schema actually needs it.
const hotelLanguagesShape = z
  .object({
    languages: z.array(z.enum(LANGUAGE_OPTIONS)).min(1, "Sélectionnez au moins une langue."),
    default_language: z.enum(LANGUAGE_OPTIONS),
  })
  .merge(hotelBookingLinksSchema);

const defaultLanguageMustBeSelected = {
  check: (data: { languages: string[]; default_language: string }) => data.languages.includes(data.default_language),
  issue: {
    message: "La langue par défaut doit faire partie des langues sélectionnées.",
    path: ["default_language"] as (string | number)[],
  },
};

// Used for the wizard's per-step validation (features/hotels/wizard/Wizard.tsx) —
// never merged into another schema, only .safeParse()'d directly.
export const hotelLanguagesSchema = hotelLanguagesShape.refine(
  defaultLanguageMustBeSelected.check,
  defaultLanguageMustBeSelected.issue
);

export const hotelAssistantIntroSchema = z.object({
  assistant_enabled: z.boolean(),
  assistant_name: z.string().trim().min(1, "Donnez un nom à l’assistant."),
  welcome_message: z.string().trim().min(1, "Le message d’accueil est obligatoire."),
});

export const createHotelSchema = z
  .object({})
  .merge(hotelInfoSchema)
  .merge(hotelIdentitySchema)
  .merge(hotelLanguagesShape)
  .merge(hotelAssistantIntroSchema)
  .refine(defaultLanguageMustBeSelected.check, defaultLanguageMustBeSelected.issue);

export type CreateHotelInput = z.infer<typeof createHotelSchema>;

export const updateHotelInfoSchema = hotelInfoSchema.merge(hotelIdentitySchema).merge(hotelBookingLinksSchema);
export type UpdateHotelInfoInput = z.infer<typeof updateHotelInfoSchema>;

export { LANGUAGE_OPTIONS };
