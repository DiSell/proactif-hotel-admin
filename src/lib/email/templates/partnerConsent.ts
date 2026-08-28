import type { EmailTemplate } from "../types";

export interface PartnerConsentTemplateParams {
  hotelName: string;
  partnerName: string;
  /**
   * The FULL public consent-management URL (this app's own
   * /partenaires/consentement page, carrying ?token=...) — built by the
   * caller (features/partners/actions.ts) from
   * features/partners/consentToken.ts's generateConsentToken(). This
   * template never constructs or guesses a URL itself, and never sees the
   * token separately from this already-assembled URL.
   *
   * ONE link for BOTH authorizations below — see actions.ts's own doc
   * comment on requestPartnerConsentsInternal for how a single token can
   * safely resolve to up to two independent, separately-gated database
   * columns without merging their statuses.
   */
  consentUrl: string;
}

/**
 * The SINGLE partner-consent email — deliberately covers BOTH independent
 * authorizations (chatbot recommendation + transactional WhatsApp) in one
 * message, rather than sending two separate emails from two separate
 * templates. The two consents remain fully independent in the database
 * (hotel_partners.consent_status vs whatsapp_consent_status) and on the
 * public page itself (two separate Accept/Decline blocks) — this email is
 * only a single notification pointing to the one place both are managed.
 * Plain, professional, no marketing, no tracking — matches this project's
 * existing transactional-email tone (see hotelInvitation.ts/passwordRecovery.ts).
 */
export function partnerConsentTemplate({ hotelName, partnerName, consentUrl }: PartnerConsentTemplateParams): EmailTemplate {
  const subject = `${hotelName} souhaite vous référencer comme partenaire`;

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1A1D1A;">
  <p style="font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: #8A6A3E; text-transform: uppercase; margin: 0 0 24px;">Proactif System</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">Bonjour ${partnerName},</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 12px;">
    L'établissement « ${hotelName} » souhaite vous référencer comme partenaire. Depuis le lien sécurisé ci-dessous, vous pouvez gérer séparément :
  </p>
  <ul style="font-size: 14px; line-height: 1.6; margin: 0 0 16px; padding-left: 20px;">
    <li>votre autorisation d'être recommandé(e) à ses visiteurs par son assistant virtuel (chatbot) ;</li>
    <li>votre autorisation de recevoir les demandes de ses clients (réservations, questions) via WhatsApp.</li>
  </ul>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
    Ces deux autorisations sont indépendantes : vous pouvez accepter l'une et refuser l'autre.
  </p>
  <p style="margin: 0 0 24px;">
    <a href="${consentUrl}" style="display: inline-block; background: #1A1D1A; color: #FBFAF7; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-size: 14px; font-weight: 500;">
      Gérer mes autorisations
    </a>
  </p>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0 0 8px;">
    Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :
  </p>
  <p style="font-size: 12px; line-height: 1.6; word-break: break-all; margin: 0 0 24px;">
    <a href="${consentUrl}" style="color: #8A6A3E;">${consentUrl}</a>
  </p>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0;">
    Ce lien est personnel et à usage unique. Si vous n'êtes pas concerné(e) par cette demande, vous pouvez ignorer cet email.
  </p>
</div>
`.trim();

  const text = [
    `Bonjour ${partnerName},`,
    "",
    `L'établissement « ${hotelName} » souhaite vous référencer comme partenaire. Depuis le lien sécurisé ci-dessous, vous pouvez gérer séparément :`,
    "- votre autorisation d'être recommandé(e) à ses visiteurs par son assistant virtuel (chatbot) ;",
    "- votre autorisation de recevoir les demandes de ses clients (réservations, questions) via WhatsApp.",
    "",
    "Ces deux autorisations sont indépendantes : vous pouvez accepter l'une et refuser l'autre.",
    "",
    `Gérez vos autorisations : ${consentUrl}`,
    "",
    "Ce lien est personnel et à usage unique. Si vous n'êtes pas concerné(e) par cette demande, vous pouvez ignorer cet email.",
  ].join("\n");

  return { subject, html, text };
}
