import { describe, expect, it } from "vitest";
import { spaBookingNotificationTemplate } from "./spaBookingNotification";

function params(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hotelName: "Le 1837",
    guestName: "Marie Dupont",
    guestPhoneE164: "+33612345678",
    partySize: 2,
    bookingDate: "2026-09-15",
    slotStart: "10:00",
    isNonResident: false,
    notes: null,
    ...overrides,
  } as Parameters<typeof spaBookingNotificationTemplate>[0];
}

describe("spaBookingNotificationTemplate", () => {
  it("[key details present]", () => {
    const template = spaBookingNotificationTemplate(params());
    for (const value of ["Marie Dupont", "+33612345678", "10:00"]) {
      expect(template.text).toContain(value);
      expect(template.html).toContain(value);
    }
  });

  it("[never presented as a request for approval — the booking is already auto-confirmed]", () => {
    const template = spaBookingNotificationTemplate(params());
    expect(template.text).toMatch(/pas une demande d'approbation/i);
  });

  it("[missing guest name/phone degrades to an honest placeholder, never blank or invented]", () => {
    const template = spaBookingNotificationTemplate(params({ guestName: null, guestPhoneE164: null }));
    expect(template.text).toMatch(/non communiqué/);
  });

  it("[non-resident flag reflected]", () => {
    const template = spaBookingNotificationTemplate(params({ isNonResident: true }));
    expect(template.text).toMatch(/oui/);
  });

  it("[notes included only when present]", () => {
    const withNotes = spaBookingNotificationTemplate(params({ notes: "Allergie aux huiles essentielles" }));
    expect(withNotes.text).toContain("Allergie aux huiles essentielles");

    const withoutNotes = spaBookingNotificationTemplate(params({ notes: null }));
    expect(withoutNotes.text).not.toMatch(/Note du client/);
  });

  it("[never marketing tone]", () => {
    const template = spaBookingNotificationTemplate(params());
    for (const forbidden of [/newsletter/i, /promotion/i, /offre spéciale/i]) {
      expect(template.html).not.toMatch(forbidden);
      expect(template.text).not.toMatch(forbidden);
    }
  });

  it("[subject reflects the booking date and time]", () => {
    const template = spaBookingNotificationTemplate(params());
    expect(template.subject).toContain("10:00");
  });
});
