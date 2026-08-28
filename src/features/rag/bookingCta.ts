import { parseHostBookingTrigger } from "@/features/hotels/hostBookingTrigger";
import type { Hotel } from "@/types/database";

export type BookingCtaKind = "url" | "host_widget" | "none";

/**
 * The single place that decides WHICH family of booking CTA a hotel can
 * offer, from its own configuration alone — independent of
 * bookingIntentDetected (the caller's job to gate on, see answer.ts) and
 * independent of the RoomRecommendation-dedup nuance (see answer.ts's
 * buildBookingAction, which additionally suppresses "url" specifically
 * when a RoomRecommendation already renders its own link). Lives here
 * (not in answer.ts or prompt.ts) so both can import the exact same
 * decision without a circular dependency — answer.ts already imports FROM
 * prompt.ts, so prompt.ts cannot import back from answer.ts.
 *
 * "host_widget" is only ever returned when host_booking_trigger actually
 * parses — a hotel misconfigured as booking_action_mode="host_widget"
 * with a missing/malformed trigger falls back to "none", never a broken
 * action (see hostBookingTrigger.ts's parseHostBookingTrigger).
 */
export function bookingCtaKind(hotel: Pick<Hotel, "booking_action_mode" | "booking_url" | "host_booking_trigger">): BookingCtaKind {
  if (hotel.booking_action_mode === "host_widget") {
    return parseHostBookingTrigger(hotel.host_booking_trigger) ? "host_widget" : "none";
  }
  return hotel.booking_url ? "url" : "none";
}
