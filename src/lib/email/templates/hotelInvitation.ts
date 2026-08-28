import type { EmailTemplate } from "../types";

export interface HotelInvitationTemplateParams {
  /** null when the invited person's first name isn't known/set — falls back to a neutral greeting, never a guessed name. */
  recipientName: string | null;
  /**
   * The FULL activation URL (this app's own /login/reset-password page,
   * carrying ?token_hash=...&type=invite) — built by the caller
   * (features/hotelUsers/actions.ts) from Supabase's generateLink()
   * response. This template never constructs or guesses a URL itself.
   */
  activationUrl: string;
}

/** Plain, professional, no marketing, no tracking — matches this project's existing transactional-email tone (see passwordRecovery.ts). */
export function hotelInvitationTemplate({ recipientName, activationUrl }: HotelInvitationTemplateParams): EmailTemplate {
  const greeting = recipientName ? `Bonjour ${recipientName},` : "Bonjour,";
  const subject = "Votre accès Proactif System";

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1A1D1A;">
  <p style="font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: #8A6A3E; text-transform: uppercase; margin: 0 0 24px;">Proactif System</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">${greeting}</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
    Vous avez été invité(e) à accéder à l'espace de gestion de votre établissement sur Proactif System.
  </p>
  <p style="margin: 0 0 24px;">
    <a href="${activationUrl}" style="display: inline-block; background: #1A1D1A; color: #FBFAF7; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-size: 14px; font-weight: 500;">
      Activer mon accès
    </a>
  </p>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0 0 8px;">
    Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :
  </p>
  <p style="font-size: 12px; line-height: 1.6; word-break: break-all; margin: 0 0 24px;">
    <a href="${activationUrl}" style="color: #8A6A3E;">${activationUrl}</a>
  </p>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0;">
    Ce lien est personnel et à usage unique. Ne le transmettez à personne.
  </p>
</div>
`.trim();

  const text = [
    greeting,
    "",
    "Vous avez été invité(e) à accéder à l'espace de gestion de votre établissement sur Proactif System.",
    "",
    `Activez votre accès : ${activationUrl}`,
    "",
    "Ce lien est personnel et à usage unique. Ne le transmettez à personne.",
  ].join("\n");

  return { subject, html, text };
}
