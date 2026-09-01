import { z } from "zod";

/**
 * Mirrors supabase/migrations/0033_hotel_spa_settings.sql's own CHECK
 * constraints — validated here too so a client gets a clear, field-attributed
 * error message instead of a raw Postgres constraint-violation string, same
 * discipline as features/events/schema.ts's hotelEventSchema.
 *
 * "slot_duration_minutes evenly divides the opening window" is a UX rule
 * (clean slot boundaries), not a data-integrity one — it lives here only,
 * never as a DB CHECK (time arithmetic modulo is awkward in Postgres — see
 * the migration's own comment). slot_duration_minutes stays the SINGLE
 * source of truth for slot length everywhere downstream (features/spa/booking.ts,
 * features/rag/spaBookingFlow.ts) — never hardcode a duration.
 */

const TIME_FORMAT = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

function parseTimeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

const timeSchema = z.string().trim().regex(TIME_FORMAT, "Heure invalide (HH:MM attendu).");

/** Same E.164 shape as every other phone field in this codebase (features/partnerRequests, hotel_partners). */
const E164_FORMAT = /^\+[1-9][0-9]{7,14}$/;

export const HOTEL_SPA_APPROVAL_MODES = ["auto", "manual"] as const;

export const hotelSpaSettingsSchema = z
  .object({
    enabled: z.boolean(),
    opens_at: timeSchema,
    closes_at: timeSchema,
    slot_duration_minutes: z.number().int().min(15, "Durée minimale : 15 minutes.").max(480, "Durée maximale : 8 heures."),
    capacity_per_slot: z.number().int().min(1, "La capacité doit être d'au moins 1 personne."),
    price_per_person: z.number().min(0, "Le prix ne peut pas être négatif.").nullable(),
    allow_non_residents: z.boolean(),
    advance_booking_days: z.number().int().min(0).max(365, "365 jours maximum."),
    min_notice_hours: z.number().int().min(0).max(168, "168 heures (7 jours) maximum."),
    approval_mode: z.enum(HOTEL_SPA_APPROVAL_MODES, { message: "Choisissez un mode de validation." }),
    // Optional even in "manual" mode, deliberately — the client-portal
    // Confirmer/Refuser buttons (SpaBookingsList.tsx) always work regardless,
    // and a new Meta-approved message template is an external prerequisite
    // for WhatsApp itself to ever actually send (see 0035_spa_booking_approval.sql).
    whatsapp_admin_phone_e164: z
      .string()
      .trim()
      .optional()
      .or(z.literal(""))
      .nullable()
      .transform((value) => (value ? value : null))
      .refine((value) => value === null || E164_FORMAT.test(value), { message: "Numéro invalide (format international requis, ex. +33612345678)." }),
  })
  .superRefine((data, ctx) => {
    const opensMinutes = parseTimeToMinutes(data.opens_at);
    const closesMinutes = parseTimeToMinutes(data.closes_at);

    if (closesMinutes <= opensMinutes) {
      ctx.addIssue({ code: "custom", path: ["closes_at"], message: "L'heure de fermeture doit être postérieure à l'heure d'ouverture." });
      return;
    }

    const windowMinutes = closesMinutes - opensMinutes;
    if (windowMinutes % data.slot_duration_minutes !== 0) {
      ctx.addIssue({
        code: "custom",
        path: ["slot_duration_minutes"],
        message: "La durée d'un créneau doit diviser exactement la plage horaire d'ouverture.",
      });
    }
  });

export type HotelSpaSettingsInput = z.infer<typeof hotelSpaSettingsSchema>;

export const DEFAULT_SPA_SETTINGS_INPUT: HotelSpaSettingsInput = {
  enabled: false,
  opens_at: "10:00",
  closes_at: "20:00",
  slot_duration_minutes: 120,
  capacity_per_slot: 4,
  price_per_person: null,
  allow_non_residents: true,
  advance_booking_days: 30,
  min_notice_hours: 2,
  approval_mode: "auto",
  whatsapp_admin_phone_e164: null,
};
