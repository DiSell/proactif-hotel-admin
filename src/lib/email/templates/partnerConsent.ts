import type { EmailTemplate } from "../types";

export interface PartnerConsentTemplateParams {
  hotelName: string;
  partnerName: string;
  /**
   * The FULL public confirmation URL (this app's own
   * /partenaires/consentement page, carrying ?token=...) — built by the
   * caller (features/partners/actions.ts) from
   * features/partners/consentToken.ts's generateConsentToken(). This
   * template never constructs or guesses a URL itself, and never sees the
   * token separately from this already-assembled URL.
   */
  consentUrl: string;
}

/** Plain, professional, no marketing, no tracking — matches this project's existing transactional-email tone (see hotelInvitation.ts/passwordRecovery.ts). */
export function partnerConsentTemplate({ hotelName, partnerName, consentUrl }: PartnerConsentTemplateParams): EmailTemplate {
  const subject = `${hotelName} souhaite vous recommander à ses visiteurs`;

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1A1D1A;">
  <p style="font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: #8A6A3E; text-transform: uppercase; margin: 0 0 24px;">Proactif System</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">Bonjour ${partnerName},</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
    L'établissement « ${hotelName} » souhaite vous recommander à ses visiteurs via son assistant virtuel (chatbot).
    Avant toute mise en avant, nous avons besoin de votre accord.
  </p>
  <p style="margin: 0 0 24px;">
    <a href="${consentUrl}" style="display: inline-block; background: #1A1D1A; color: #FBFAF7; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-size: 14px; font-weight: 500;">
      Répondre à cette demande
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
    `L'établissement « ${hotelName} » souhaite vous recommander à ses visiteurs via son assistant virtuel (chatbot). Avant toute mise en avant, nous avons besoin de votre accord.`,
    "",
    `Répondez à cette demande : ${consentUrl}`,
    "",
    "Ce lien est personnel et à usage unique. Si vous n'êtes pas concerné(e) par cette demande, vous pouvez ignorer cet email.",
  ].join("\n");

  return { subject, html, text };
}
