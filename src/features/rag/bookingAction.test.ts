import { describe, expect, it } from "vitest";
import { isBookingIntent, buildBookingAction } from "./answer";

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

describe("buildBookingAction", () => {
  it("[intent + booking_url] returns a booking action pointing at exactly the given URL", () => {
    const action = buildBookingAction(true, "https://booking.example.com/le1837");
    expect(action).toEqual({ type: "booking", label: "Réserver", url: "https://booking.example.com/le1837" });
  });

  it("[intent, no booking_url] returns null — never a button with a null/invented URL", () => {
    expect(buildBookingAction(true, null)).toBeNull();
  });

  it("[booking_url configured, no intent] returns null — the CTA is never shown unprompted", () => {
    expect(buildBookingAction(false, "https://booking.example.com/le1837")).toBeNull();
  });

  it("[neither] returns null", () => {
    expect(buildBookingAction(false, null)).toBeNull();
  });

  it("[dedup mechanism] passing null explicitly (e.g. because a RoomRecommendation already covers this turn) suppresses the action exactly like a hotel with no booking_url would", () => {
    // Same code path either way — see answerGrounded's call site in
    // answer.ts, which passes `roomRecommendation ? null : hotel.booking_url`.
    expect(buildBookingAction(true, null)).toBeNull();
  });
});
