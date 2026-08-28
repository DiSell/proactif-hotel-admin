import { describe, expect, it } from "vitest";
import { partnerConsentTemplate } from "./partnerConsent";

function params(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hotelName: "Le 1837",
    partnerName: "Restaurant du Centre",
    consentUrl: "https://assistant.proactifsystem.com/partenaires/consentement?token=abc123",
    ...overrides,
  } as Parameters<typeof partnerConsentTemplate>[0];
}

/**
 * This is now the SINGLE partner-consent email — covering both the
 * chatbot-recommendation and the transactional-WhatsApp authorizations in
 * one message. There is deliberately no second template
 * (partnerTransactionalConsent.ts was removed) and no second sendEmail
 * call anywhere in the codebase (see actions.test.ts's own
 * "[single email, single template]" test).
 */
describe("partnerConsentTemplate — the ONE email covering BOTH independent authorizations", () => {
  it("[mentions both authorizations, described as independent]", () => {
    const template = partnerConsentTemplate(params());
    expect(template.html).toMatch(/recommand/i);
    expect(template.html).toMatch(/WhatsApp/);
    expect(template.text).toMatch(/recommand/i);
    expect(template.text).toMatch(/WhatsApp/);
    expect(template.html).toMatch(/indépendantes/i);
  });

  it("[never presented as marketing/newsletter/démarchage/réservation automatique]", () => {
    const template = partnerConsentTemplate(params());
    for (const forbidden of [/newsletter/i, /marketing/i, /démarchage/i, /réservation automatique/i, /inscri/i]) {
      expect(template.html).not.toMatch(forbidden);
      expect(template.text).not.toMatch(forbidden);
    }
  });

  it("[single link, no ?type= parameter] the same link manages both authorizations, never two separate links", () => {
    const url = "https://assistant.proactifsystem.com/partenaires/consentement?token=xyz";
    const template = partnerConsentTemplate(params({ consentUrl: url }));
    expect(template.html).toContain(url);
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(template.html.match(new RegExp(`href="${escapedUrl}"`, "g"))?.length).toBe(2); // the CTA button and the plain-text fallback link, both pointing at the SAME single URL
    expect(template.html).not.toMatch(/type=whatsapp/);
  });

  it("[hotel and partner names interpolated]", () => {
    const template = partnerConsentTemplate(params({ hotelName: "Chabanettes", partnerName: "Taxi Express" }));
    expect(template.text).toContain("Chabanettes");
    expect(template.text).toContain("Taxi Express");
  });

  it("[subject reflects a general partnership request, not just one of the two authorizations]", () => {
    const template = partnerConsentTemplate(params());
    expect(template.subject).not.toMatch(/uniquement|seulement/i);
  });
});
