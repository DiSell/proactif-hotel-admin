import type { EmailTemplate } from "../types";

export interface PasswordRecoveryTemplateParams {
  /**
   * The FULL reset URL (this app's own /login/reset-password page,
   * carrying ?token_hash=...&type=recovery) — built by the caller
   * (features/auth/actions.ts) from Supabase's generateLink() response.
   * This template never constructs or guesses a URL itself.
   */
  resetUrl: string;
}

/**
 * Sent ONLY when the email genuinely matches an existing account — see
 * requestPasswordReset's own doc comment (features/auth/actions.ts) on
 * anti-enumeration: the caller decides whether to send this at all, this
 * template has no opinion on that.
 */
export function passwordRecoveryTemplate({ resetUrl }: PasswordRecoveryTemplateParams): EmailTemplate {
  const subject = "Réinitialisation de votre mot de passe Proactif System";

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1A1D1A;">
  <p style="font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: #8A6A3E; text-transform: uppercase; margin: 0 0 24px;">Proactif System</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
    Une demande de réinitialisation de mot de passe a été effectuée pour votre compte.
  </p>
  <p style="margin: 0 0 24px;">
    <a href="${resetUrl}" style="display: inline-block; background: #1A1D1A; color: #FBFAF7; text-decoration: none; padding: 12px 28px; border-radius: 9999px; font-size: 14px; font-weight: 500;">
      Réinitialiser mon mot de passe
    </a>
  </p>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0 0 8px;">
    Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :
  </p>
  <p style="font-size: 12px; line-height: 1.6; word-break: break-all; margin: 0 0 24px;">
    <a href="${resetUrl}" style="color: #8A6A3E;">${resetUrl}</a>
  </p>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0;">
    Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email — votre mot de passe reste inchangé.
  </p>
</div>
`.trim();

  const text = [
    "Une demande de réinitialisation de mot de passe a été effectuée pour votre compte.",
    "",
    `Réinitialisez votre mot de passe : ${resetUrl}`,
    "",
    "Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email — votre mot de passe reste inchangé.",
  ].join("\n");

  return { subject, html, text };
}
