import { z } from "zod";
import type { HotelEventType } from "@/types/database";

/** Single source of truth for the closed type list — mirrors the CHECK constraint in supabase/migrations/0032_hotel_events.sql exactly. */
export const HOTEL_EVENT_TYPES = ["permanent", "temporary"] as const satisfies readonly HotelEventType[];

export const HOTEL_EVENT_TYPE_LABEL: Record<HotelEventType, string> = {
  permanent: "Information permanente",
  temporary: "Événement temporaire",
};

const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date input, normalized to `string | null` — `""` (an untouched/cleared
 * HTML date input) and `undefined` both become `null`, never an empty
 * string reaching the database (0032's own CHECK constraints require
 * either both dates present or both absent, never a blank string as a
 * third state).
 */
const optionalDateSchema = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || DATE_FORMAT.test(value), { message: "Date invalide (AAAA-MM-JJ attendue)." });

/**
 * Cross-field rules mirror 0032_hotel_events.sql's own CHECK constraints
 * exactly (hotel_events_temporary_dates, hotel_events_banner_requires_temporary)
 * — validated here too so a client ever gets a clear, field-attributed
 * error message instead of a raw Postgres constraint-violation string.
 */
export const hotelEventSchema = z
  .object({
    type: z.enum(HOTEL_EVENT_TYPES, { message: "Choisissez un type." }),
    title: z.string().trim().min(1, "Le titre est obligatoire.").max(200, "Titre trop long (200 caractères maximum)."),
    content: z.string().trim().min(1, "Le contenu est obligatoire.").max(2000, "Contenu trop long (2000 caractères maximum)."),
    starts_at: optionalDateSchema,
    ends_at: optionalDateSchema,
    is_active: z.boolean(),
    show_as_banner: z.boolean(),
  })
  .superRefine((data, ctx) => {
    if (data.type === "temporary") {
      if (!data.starts_at) ctx.addIssue({ code: "custom", path: ["starts_at"], message: "La date de début est obligatoire pour un événement temporaire." });
      if (!data.ends_at) ctx.addIssue({ code: "custom", path: ["ends_at"], message: "La date de fin est obligatoire pour un événement temporaire." });
      if (data.starts_at && data.ends_at && data.ends_at < data.starts_at) {
        ctx.addIssue({ code: "custom", path: ["ends_at"], message: "La date de fin doit être postérieure ou égale à la date de début." });
      }
    } else {
      if (data.starts_at || data.ends_at) {
        ctx.addIssue({ code: "custom", path: ["starts_at"], message: "Une information permanente ne peut pas avoir de dates." });
      }
      if (data.show_as_banner) {
        ctx.addIssue({ code: "custom", path: ["show_as_banner"], message: "Le bandeau n'est disponible que pour un événement temporaire." });
      }
    }
  });

export type HotelEventInput = z.infer<typeof hotelEventSchema>;
