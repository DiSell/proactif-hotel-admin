import { describe, expect, it } from "vitest";
import { isBookingIntent, buildBookingAction } from "./answer";
import type { Hotel } from "@/types/database";

describe("isBookingIntent", () => {
  it("[reservation] detects an explicit reservation request", () => {
    expect(isBookingIntent("Je voudrais réserver une chambre pour deux nuits.")).toBe(true);
  });

  it("[availability] detects an availability question", () => {
    expect(isBookingIntent("Avez-vous de la place le 12 mars ?")).toBe(true);
  });

  it("[price] detects a price question — broader than isAvailabilityRequest on purpose", () => {
    expect(isBookingIntent("Combien coûte une nuit en haute saison ?")).toBe(true);
    expect(isBookingIntent("Quel est le prix de la suite ?")).toBe(true);
    expect(isBookingIntent("What are your rates for a weekend?")).toBe(true);
  });

  it("[unrelated] a question with no reservation/availability/price wording returns false", () => {
    expect(isBookingIntent("À quelle heure sert-on le petit-déjeuner ?")).toBe(false);
    expect(isBookingIntent("Le parking est-il gratuit ?")).toBe(false);
    expect(isBookingIntent("Bonjour !")).toBe(false);
  });
});

type BookingFields = Pick<Hotel, "booking_action_mode" | "booking_url" | "host_booking_trigger">;

function urlHotel(bookingUrl: string | null): BookingFields {
  return { booking_action_mode: "url", booking_url: bookingUrl, host_booking_trigger: null };
}

function hostWidgetHotel(trigger: unknown): BookingFields {
  return { booking_action_mode: "host_widget", booking_url: null, host_booking_trigger: trigger };
}

describe("buildBookingAction", () => {
  it("[url mode, intent + booking_url] returns a booking action pointing at exactly the given URL", () => {
    const action = buildBookingAction(true, urlHotel("https://booking.example.com/le1837"));
    expect(action).toEqual({ type: "booking", label: "Réserver", url: "https://booking.example.com/le1837" });
  });

  it("[url mode, intent, no booking_url] returns null — never a button with a null/invented URL", () => {
    expect(buildBookingAction(true, urlHotel(null))).toBeNull();
  });

  it("[url mode, booking_url configured, no intent] returns null — the CTA is never shown unprompted", () => {
    expect(buildBookingAction(false, urlHotel("https://booking.example.com/le1837"))).toBeNull();
  });

  it("[url mode, neither] returns null", () => {
    expect(buildBookingAction(false, urlHotel(null))).toBeNull();
  });

  it("[host_widget mode, intent + valid trigger] returns a host_booking action — never a selector, never a URL", () => {
    const action = buildBookingAction(true, hostWidgetHotel({ strategy: "click", selector: "#resa-toggle-menu" }));
    expect(action).toEqual({ type: "host_booking", label: "Réserver" });
  });

  it("[host_widget mode, no intent] returns null even with a valid trigger — the CTA is never shown unprompted", () => {
    expect(buildBookingAction(false, hostWidgetHotel({ strategy: "click", selector: "#resa-toggle-menu" }))).toBeNull();
  });

  it("[host_widget mode, missing trigger] fails safe — returns null, never a broken action", () => {
    expect(buildBookingAction(true, hostWidgetHotel(null))).toBeNull();
  });

  it("[host_widget mode, malformed trigger] fails safe — wrong strategy, missing selector, and extra fields all resolve to null", () => {
    expect(buildBookingAction(true, hostWidgetHotel({ strategy: "scroll", selector: "#resa" }))).toBeNull();
    expect(buildBookingAction(true, hostWidgetHotel({ strategy: "click" }))).toBeNull();
    expect(buildBookingAction(true, hostWidgetHotel({ strategy: "click", selector: "" }))).toBeNull();
    expect(buildBookingAction(true, hostWidgetHotel({ strategy: "click", selector: "#resa", javascript: "alert(1)" }))).toBeNull();
  });
});
