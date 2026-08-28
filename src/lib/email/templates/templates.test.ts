import { describe, expect, it } from "vitest";
import { hotelInvitationTemplate } from "./hotelInvitation";
import { passwordRecoveryTemplate } from "./passwordRecovery";
import { partnerConsentTemplate } from "./partnerConsent";

describe("hotelInvitationTemplate", () => {
  it("[subject] matches the requested copy exactly", () => {
    const { subject } = hotelInvitationTemplate({ recipientName: "Jean", activationUrl: "https://app.example.com/x" });
    expect(subject).toBe("Votre accès Proactif System");
  });

  it("[url embedded, never fabricated] the exact activationUrl passed in appears in both html and text, untouched", () => {
    const url = "https://app.example.com/login/reset-password?token_hash=abc123&type=invite";
    const template = hotelInvitationTemplate({ recipientName: "Jean", activationUrl: url });
    expect(template.html).toContain(url);
    expect(template.text).toContain(url);
  });

  it("[named greeting] uses the recipient's first name when provided", () => {
    const template = hotelInvitationTemplate({ recipientName: "Marie", activationUrl: "https://x" });
    expect(template.html).toMatch(/Bonjour Marie,/);
  });

  it("[no name -> neutral greeting] never fabricates a name", () => {
    const template = hotelInvitationTemplate({ recipientName: null, activationUrl: "https://x" });
    expect(template.html).toMatch(/Bonjour,/);
    expect(template.html).not.toMatch(/Bonjour null/);
  });

  it("[sober, no marketing/tracking] no tracking pixel, no UTM params, no unsubscribe/marketing footer", () => {
    const template = hotelInvitationTemplate({ recipientName: "Jean", activationUrl: "https://x" });
    expect(template.html).not.toMatch(/utm_/i);
    expect(template.html).not.toMatch(/unsubscribe/i);
    expect(template.html).not.toMatch(/<img/i);
  });

  it("[personal, single-use note] tells the recipient the link is personal", () => {
    const template = hotelInvitationTemplate({ recipientName: "Jean", activationUrl: "https://x" });
    expect(template.html).toMatch(/personnel/i);
  });
});

describe("passwordRecoveryTemplate", () => {
  it("[subject] matches the requested copy exactly", () => {
    const { subject } = passwordRecoveryTemplate({ resetUrl: "https://app.example.com/x" });
    expect(subject).toBe("Réinitialisation de votre mot de passe Proactif System");
  });

  it("[url embedded, never fabricated] the exact resetUrl passed in appears in both html and text, untouched", () => {
    const url = "https://app.example.com/login/reset-password?token_hash=xyz789&type=recovery";
    const template = passwordRecoveryTemplate({ resetUrl: url });
    expect(template.html).toContain(url);
    expect(template.text).toContain(url);
  });

  it("['ignore if not you' notice] tells the recipient to do nothing if they didn't request this", () => {
    const template = passwordRecoveryTemplate({ resetUrl: "https://x" });
    expect(template.html).toMatch(/vous pouvez ignorer cet email/i);
  });

  it("[sober, no marketing/tracking]", () => {
    const template = passwordRecoveryTemplate({ resetUrl: "https://x" });
    expect(template.html).not.toMatch(/utm_/i);
    expect(template.html).not.toMatch(/unsubscribe/i);
    expect(template.html).not.toMatch(/<img/i);
  });
});

describe("partnerConsentTemplate", () => {
  const params = { hotelName: "Hôtel du Parc", partnerName: "Le Bistrot", consentUrl: "https://app.example.com/partenaires/consentement?token=abc123" };

  it("[subject] names the hotel", () => {
    const { subject } = partnerConsentTemplate(params);
    expect(subject).toBe("Hôtel du Parc souhaite vous référencer comme partenaire");
  });

  it("[url embedded, never fabricated] the exact consentUrl passed in appears in both html and text, untouched", () => {
    const template = partnerConsentTemplate(params);
    expect(template.html).toContain(params.consentUrl);
    expect(template.text).toContain(params.consentUrl);
  });

  it("[names both parties] the partner's own name and the requesting hotel's name both appear", () => {
    const template = partnerConsentTemplate(params);
    expect(template.html).toMatch(/Le Bistrot/);
    expect(template.html).toMatch(/Hôtel du Parc/);
  });

  it("[token never appears outside the URL] the raw token substring never appears anywhere except embedded inside consentUrl", () => {
    const template = partnerConsentTemplate(params);
    const withoutUrl = template.html.split(params.consentUrl).join("");
    const textWithoutUrl = template.text.split(params.consentUrl).join("");
    expect(withoutUrl).not.toMatch(/abc123/);
    expect(textWithoutUrl).not.toMatch(/abc123/);
  });

  it("[personal, single-use note]", () => {
    const template = partnerConsentTemplate(params);
    expect(template.html).toMatch(/personnel/i);
  });

  it("[sober, no marketing/tracking]", () => {
    const template = partnerConsentTemplate(params);
    expect(template.html).not.toMatch(/utm_/i);
    expect(template.html).not.toMatch(/unsubscribe/i);
    expect(template.html).not.toMatch(/<img/i);
  });
});
