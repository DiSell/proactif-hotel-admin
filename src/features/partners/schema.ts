import { z } from "zod";
import type { HotelPartnerCategory } from "@/types/database";

/** Single source of truth for the closed category list — mirrors the CHECK constraint in supabase/migrations/0015_hotel_partners.sql exactly; keep both in sync if a category is ever added/removed. */
export const HOTEL_PARTNER_CATEGORIES = [
  "restaurant",
  "transport",
  "activity",
  "wellness",
  "shopping",
  "local_product",
  "guide",
  "rental",
  "other",
] as const satisfies readonly HotelPartnerCategory[];

export const HOTEL_PARTNER_CATEGORY_LABEL: Record<HotelPartnerCategory, string> = {
  restaurant: "Restaurant",
  transport: "Transport",
  activity: "Activité",
  wellness: "Bien-être",
  shopping: "Commerce",
  local_product: "Producteur local",
  guide: "Guide",
  rental: "Location",
  other: "Autre",
};

const HTTP_URL_MESSAGE = "Entrez une URL valide commençant par http:// ou https://.";

/**
 * Same reasoning and same check as features/hotels/schema.ts's httpUrlSchema
 * (not exported from there, so duplicated here rather than reaching across
 * features): z.string().url() alone accepts javascript:/data:/file: URLs,
 * which would end up rendered as a real <a href> in the chat widget
 * (PublicWidgetChat.tsx/ChatPreview.tsx) once a partner's website_url/
 * booking_url becomes a CTA link (features/rag/partners.ts). Restricting to
 * http/https here is what makes "website_url sûre" actually true, not just
 * documented.
 */
function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// Exported so features/partners/actions.ts's fetchPartnerWebsiteSummary can
// reuse the exact same http/https-only check on the URL it's about to fetch
// server-side, instead of a third duplicate of isHttpUrl.
export const httpUrlSchema = z.string().trim().refine(isHttpUrl, { message: HTTP_URL_MESSAGE });

export const hotelPartnerSchema = z.object({
  name: z.string().trim().min(1, "Le nom est obligatoire.").max(200, "Nom trop long (200 caractères maximum)."),
  category: z.enum(HOTEL_PARTNER_CATEGORIES, { message: "Choisissez une catégorie." }),
  description: z.string().trim().max(2000, "Description trop longue (2000 caractères maximum).").optional().or(z.literal("")),
  address: z.string().trim().max(300, "Adresse trop longue.").optional().or(z.literal("")),
  phone: z.string().trim().max(50, "Numéro trop long.").optional().or(z.literal("")),
  // Free text, never parsed/computed — see 0018_hotel_partner_opening_hours.sql's own comment.
  opening_hours: z.string().trim().max(300, "Horaires trop longs.").optional().or(z.literal("")),
  // Used only to send the consent request (features/partners/actions.ts::
  // requestPartnerConsent*) — optional, since a partner can exist before an
  // email is known, but the "Envoyer la demande de consentement" button
  // stays disabled until one is set.
  email: z.string().trim().email("Entrez un email valide.").max(320, "Email trop long.").optional().or(z.literal("")),
  website_url: httpUrlSchema.optional().or(z.literal("")),
  booking_url: httpUrlSchema.optional().or(z.literal("")),
  is_active: z.boolean(),
  // Simple ordering knob, not a scoring algorithm (see the product spec's
  // own "pas d'algorithme complexe") — bounded well above any realistic
  // hand-picked value, just enough to reject garbage input.
  priority: z.coerce.number().int().min(0, "La priorité ne peut pas être négative.").max(1000, "Priorité trop élevée."),
});
export type HotelPartnerInput = z.infer<typeof hotelPartnerSchema>;
