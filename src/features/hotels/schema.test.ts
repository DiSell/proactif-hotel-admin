import { describe, expect, it } from "vitest";
import { updateHotelInfoSchema, hotelLanguagesSchema } from "./schema";

function validUpdateInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Le 1837",
    website: "https://le1837.com",
    address: "",
    postal_code: "",
    city: "",
    country: "",
    phone: "",
    email: "",
    primary_color: "#1A1D1A",
    secondary_color: "#8A6A3E",
    booking_url: "",
    spa_booking_url: "",
    booking_action_mode: "url",
    host_booking_selector: "",
    ...overrides,
  };
}

describe("updateHotelInfoSchema — booking_url / spa_booking_url", () => {
  it("accepts a valid https URL for booking_url", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_url: "https://booking.example.com/le1837" }));
    expect(result.success).toBe(true);
  });

  it("accepts a valid http URL for spa_booking_url", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ spa_booking_url: "http://spa.example.com" }));
    expect(result.success).toBe(true);
  });

  it("accepts an empty string for both fields — no booking link configured is valid", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_url: "", spa_booking_url: "" }));
    expect(result.success).toBe(true);
  });

  it("[security] rejects javascript: as booking_url", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_url: "javascript:alert(1)" }));
    expect(result.success).toBe(false);
  });

  it("[security] rejects data: as booking_url", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_url: "data:text/html,<script>alert(1)</script>" }));
    expect(result.success).toBe(false);
  });

  it("[security] rejects file: as spa_booking_url", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ spa_booking_url: "file:///etc/passwd" }));
    expect(result.success).toBe(false);
  });

  it("rejects a bare domain with no scheme (same requirement as before — an explicit http/https is mandatory)", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_url: "le1837.com/reserver" }));
    expect(result.success).toBe(false);
  });

  it("rejects an unrelated scheme like ftp:", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_url: "ftp://example.com/file" }));
    expect(result.success).toBe(false);
  });
});

describe("updateHotelInfoSchema — booking_action_mode / host_booking_selector", () => {
  it("[url mode, default] accepts an empty selector — irrelevant in this mode", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_action_mode: "url", host_booking_selector: "" }));
    expect(result.success).toBe(true);
  });

  it("[host_widget mode, selector provided] accepted", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_action_mode: "host_widget", host_booking_selector: "#resa-toggle-menu" }));
    expect(result.success).toBe(true);
  });

  it("[host_widget mode, empty selector] rejected — a selector is required in this mode", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_action_mode: "host_widget", host_booking_selector: "" }));
    expect(result.success).toBe(false);
  });

  it("[host_widget mode, selector too long] rejected — 201 characters exceeds the 200-char bound", () => {
    const result = updateHotelInfoSchema.safeParse(
      validUpdateInput({ booking_action_mode: "host_widget", host_booking_selector: "#" + "a".repeat(200) })
    );
    expect(result.success).toBe(false);
  });

  it("[invalid mode] rejects a value outside the closed enum", () => {
    const result = updateHotelInfoSchema.safeParse(validUpdateInput({ booking_action_mode: "iframe_scrape" }));
    expect(result.success).toBe(false);
  });
});

/**
 * Same validation rules apply at hotel creation (the wizard) — booking_url/
 * spa_booking_url are shared fields, not re-declared separately there. A
 * javascript:/data: URL must never reach the database via either path.
 */
describe("hotelLanguagesSchema (creation wizard) — booking_url / spa_booking_url share the same http(s)-only rule", () => {
  function validWizardInput(overrides: Record<string, unknown> = {}) {
    return {
      languages: ["fr"],
      default_language: "fr",
      booking_url: "",
      spa_booking_url: "",
      ...overrides,
    };
  }

  it("accepts a valid https booking_url", () => {
    const result = hotelLanguagesSchema.safeParse(validWizardInput({ booking_url: "https://booking.example.com" }));
    expect(result.success).toBe(true);
  });

  it("[security] rejects javascript: at creation time too", () => {
    const result = hotelLanguagesSchema.safeParse(validWizardInput({ booking_url: "javascript:alert(1)" }));
    expect(result.success).toBe(false);
  });
});
