import { describe, expect, it } from "vitest";
import { canReceivePartnerRequests } from "./canReceivePartnerRequests";

function eligiblePartner(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    is_active: true,
    consent_status: "accepted" as const,
    whatsapp_consent_status: "accepted" as const,
    request_phone_e164: "+33612345678",
    ...overrides,
  };
}

describe("canReceivePartnerRequests — the ONLY place this eligibility decision is computed", () => {
  it("[all conditions met] eligible", () => {
    expect(canReceivePartnerRequests(eligiblePartner())).toBe(true);
  });

  it("[recommendation accepted, transactional not_requested] NOT eligible — the two consents are independent, one never implies the other", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ whatsapp_consent_status: "not_requested" }))).toBe(false);
  });

  it("[transactional pending] NOT eligible — a request is in flight, not yet answered", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ whatsapp_consent_status: "pending" }))).toBe(false);
  });

  it("[transactional declined] NOT eligible", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ whatsapp_consent_status: "declined" }))).toBe(false);
  });

  it("[transactional accepted, valid request_phone_e164] eligible", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ whatsapp_consent_status: "accepted", request_phone_e164: "+33612345678" }))).toBe(true);
  });

  it("[transactional accepted but request_phone_e164 missing] NOT eligible — nothing to route a request to", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ request_phone_e164: null }))).toBe(false);
  });

  it("[transactional accepted but request_phone_e164 malformed] NOT eligible — defense in depth beyond the DB CHECK constraint", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ request_phone_e164: "0612345678" }))).toBe(false);
    expect(canReceivePartnerRequests(eligiblePartner({ request_phone_e164: "not-a-number" }))).toBe(false);
  });

  it("[partner inactive] NOT eligible, even with both consents accepted and a valid number", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ is_active: false }))).toBe(false);
  });

  it("[recommendation consent not accepted] NOT eligible — kept as a precondition even though it's a separate concern", () => {
    expect(canReceivePartnerRequests(eligiblePartner({ consent_status: "not_requested" }))).toBe(false);
    expect(canReceivePartnerRequests(eligiblePartner({ consent_status: "pending" }))).toBe(false);
    expect(canReceivePartnerRequests(eligiblePartner({ consent_status: "declined" }))).toBe(false);
  });

  it("[both consents independent — every combination exhaustively]", () => {
    const statuses = ["not_requested", "pending", "accepted", "declined"] as const;
    for (const recommendation of statuses) {
      for (const transactional of statuses) {
        const expected = recommendation === "accepted" && transactional === "accepted";
        expect(
          canReceivePartnerRequests(eligiblePartner({ consent_status: recommendation, whatsapp_consent_status: transactional })),
          `recommendation=${recommendation}, transactional=${transactional}`
        ).toBe(expected);
      }
    }
  });
});
