import { z } from "zod";
import { HOTEL_MEDIA_CATEGORIES } from "@/types/database";

/** French labels for the UI — the stored `category` value itself stays a generic, hotel-agnostic English slug (see 0046_hotel_media.sql). */
export const HOTEL_MEDIA_CATEGORY_LABEL: Record<(typeof HOTEL_MEDIA_CATEGORIES)[number], string> = {
  pool: "Piscine",
  spa: "Spa",
  sauna: "Sauna",
  hammam: "Hammam",
  jacuzzi: "Jacuzzi",
  fitness: "Salle de fitness",
  exterior: "Parc / extérieur",
  breakfast: "Petit-déjeuner",
  restaurant: "Restauration",
  seminar: "Salles de séminaire",
  wedding: "Mariages / réception",
  chapel: "Chapelle",
  facade: "Façade",
  common_area: "Espaces communs",
  parking: "Parking",
  other: "Autre",
};

export const hotelMediaCategorySchema = z.enum(HOTEL_MEDIA_CATEGORIES);

/**
 * The upload itself (turning a browser File into a Storage object) happens
 * client-side, mirroring features/hotels/wizard/StepInfo.tsx's own logo
 * upload — this schema validates only what the Server Action actually
 * receives afterward: the resulting Storage path/URL plus the metadata the
 * admin entered. hotelId is deliberately NOT part of this schema — see
 * addHotelMediaPhoto's own doc comment (actions.ts) for why, same
 * discipline as every other action in this codebase.
 */
export const addHotelMediaSchema = z.object({
  category: hotelMediaCategorySchema,
  title: z.string().trim().max(200).optional().or(z.literal("")).transform((value) => value || null),
  altText: z.string().trim().max(300).optional().or(z.literal("")).transform((value) => value || null),
  storagePath: z.string().trim().min(1).max(500),
  photoUrl: z.string().trim().url().max(2048),
  contentHash: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, "Empreinte de fichier invalide."),
});
export type AddHotelMediaInput = z.infer<typeof addHotelMediaSchema>;
