import { z } from "zod";

/**
 * How a hotel's CTA "Réserver" behaves in the widget:
 * - "url": open hotels.booking_url in a new tab (existing behavior).
 * - "host_widget": ask public/widget.js to trigger the booking module
 *   already present on the hotel's own site (see ReservationRequestModal's
 *   predecessor work — this replaces that abandoned in-widget-form
 *   approach entirely; nothing here creates a reservation, checks
 *   availability, or quotes a price).
 */
export const bookingActionModeSchema = z.enum(["url", "host_widget"]);
export type BookingActionMode = z.infer<typeof bookingActionModeSchema>;

/**
 * Closed, minimal shape for hotels.host_booking_trigger (jsonb) — a
 * deliberately narrow vocabulary, NOT a generic DOM-execution mechanism.
 * "click" is the only strategy this V1 implements (confirmed sufficient by
 * the Le 1837 / My Groom Service audit: their booking modal opens via a
 * plain click on a themed toggle element, no documented public API/event
 * exists). Adding "scroll" or any other strategy later is a non-breaking
 * extension of this union — not done now, since no real, tested need for
 * it exists yet.
 *
 * `.strict()`: an extra field (a selector-adjacent "javascript"/"html"/
 * "attribute" property, for instance) fails validation entirely rather
 * than being silently ignored — this schema is the enforcement point that
 * keeps the mechanism from ever growing into a generic DOM-execution API.
 */
export const hostBookingTriggerSchema = z
  .object({
    strategy: z.literal("click"),
    selector: z
      .string()
      .trim()
      .min(1, "Le sélecteur est requis.")
      .max(200, "Sélecteur trop long (200 caractères maximum)."),
  })
  .strict();
export type HostBookingTrigger = z.infer<typeof hostBookingTriggerSchema>;

/**
 * Fail-safe parse for untrusted/raw input — the hotels.host_booking_trigger
 * column (jsonb, no DB-level structural validation beyond "is a JSON
 * object" — see 0010_host_booking_action.sql) and the admin form's own
 * submitted value both flow through here. NEVER throws; returns null for
 * anything missing, malformed, wrong-shaped, or carrying an extra field —
 * every caller (buildBookingAction, buildPublicWidgetConfig, the admin
 * action) treats null the same way: no usable host-widget trigger, fall
 * back to "no CTA" rather than ever emitting a broken one.
 */
export function parseHostBookingTrigger(raw: unknown): HostBookingTrigger | null {
  const result = hostBookingTriggerSchema.safeParse(raw);
  return result.success ? result.data : null;
}
