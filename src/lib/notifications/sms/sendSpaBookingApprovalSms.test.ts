import { describe, expect, it } from "vitest";
import { buildSpaBookingApprovalSmsBody, type PreparedSpaBookingApprovalSms } from "./sendSpaBookingApprovalSms";

const BASE: PreparedSpaBookingApprovalSms = {
  requestPhoneE164: "+33612345678",
  hotelName: "Le 1837",
  bookingDate: "2026-10-01",
  slotStart: "14:00",
  slotEnd: "15:00",
  partySize: 2,
  guestFirstName: "Marie",
};

describe("buildSpaBookingApprovalSmsBody — strictly 2 options, never a digit 3", () => {
  it("[hotel name from data, never hardcoded]", () => {
    const body = buildSpaBookingApprovalSmsBody({ ...BASE, hotelName: "Villa Test" }, "K7M4PZ");
    expect(body).toContain("Villa Test");
    expect(body).not.toContain("Le 1837");
  });

  it("[exactly 2 reply lines, never a third]", () => {
    const body = buildSpaBookingApprovalSmsBody(BASE, "K7M4PZ");
    expect(body).toContain("1 K7M4PZ = confirmer");
    expect(body).toContain("2 K7M4PZ = refuser");
    expect(body).not.toMatch(/3 K7M4PZ/);
  });

  it("[date/slot/party size present]", () => {
    const body = buildSpaBookingApprovalSmsBody(BASE, "K7M4PZ");
    expect(body).toContain("2026-10-01");
    expect(body).toContain("14:00-15:00");
    expect(body).toContain("2 personnes");
  });
});
