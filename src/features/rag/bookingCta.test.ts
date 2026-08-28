import { describe, expect, it } from "vitest";
import { bookingCtaKind } from "./bookingCta";
import type { Hotel } from "@/types/database";

type BookingFields = Pick<Hotel, "booking_action_mode" | "booking_url" | "host_booking_trigger">;

describe("bookingCtaKind", () => {
  it("[url mode, booking_url set] returns 'url'", () => {
    const hotel: BookingFields = { booking_action_mode: "url", booking_url: "https://booking.example.com", host_booking_trigger: null };
    expect(bookingCtaKind(hotel)).toBe("url");
  });

  it("[url mode, no booking_url] returns 'none'", () => {
    const hotel: BookingFields = { booking_action_mode: "url", booking_url: null, host_booking_trigger: null };
    expect(bookingCtaKind(hotel)).toBe("none");
  });

  it("[host_widget mode, valid trigger] returns 'host_widget'", () => {
    const hotel: BookingFields = {
      booking_action_mode: "host_widget",
      booking_url: null,
      host_booking_trigger: { strategy: "click", selector: "#resa-toggle-menu" },
    };
    expect(bookingCtaKind(hotel)).toBe("host_widget");
  });

  it("[host_widget mode, missing trigger] returns 'none' — fails safe rather than a broken CTA", () => {
    const hotel: BookingFields = { booking_action_mode: "host_widget", booking_url: null, host_booking_trigger: null };
    expect(bookingCtaKind(hotel)).toBe("none");
  });

  it("[host_widget mode, malformed trigger] returns 'none'", () => {
    const hotel: BookingFields = {
      booking_action_mode: "host_widget",
      booking_url: null,
      host_booking_trigger: { strategy: "javascript", code: "alert(1)" },
    };
    expect(bookingCtaKind(hotel)).toBe("none");
  });

  it("[host_widget mode, booking_url ALSO happens to be set] still returns 'host_widget' — mode is authoritative, booking_url is ignored in this mode", () => {
    const hotel: BookingFields = {
      booking_action_mode: "host_widget",
      booking_url: "https://stale-url.example.com",
      host_booking_trigger: { strategy: "click", selector: "#resa" },
    };
    expect(bookingCtaKind(hotel)).toBe("host_widget");
  });
});
