import type { EmailTemplate } from "../types";

export interface ConversationFlaggedTemplateParams {
  hotelName: string;
  /** Short, neutral, staff-facing text from the model itself (see prompt.ts) — never the raw abusive message. */
  reason: string;
  /** Built via currentOrigin() + "/client/conversations/{id}" — never derived from a request Host header, see currentOrigin.ts. */
  conversationUrl: string;
}

/**
 * Sent to chatbot_settings.handoff_email (fallback hotels.email) the FIRST
 * time a conversation is flagged by the model's own moderation self-report
 * (see features/rag/moderation.ts) — never once per abusive message in an
 * ongoing tirade, since flag_conversation() (0036_conversation_moderation.sql)
 * is idempotent and only the first call ever triggers this email. Plain,
 * professional, no marketing — matches spaBookingNotification's tone.
 */
export function conversationFlaggedTemplate({ hotelName, reason, conversationUrl }: ConversationFlaggedTemplateParams): EmailTemplate {
  const subject = `Comportement suspect détecté dans une conversation du chatbot — ${hotelName}`;

  const introText = `Le chatbot de « ${hotelName} » a détecté un comportement potentiellement abusif de la part d'un visiteur (${reason}). L'assistant a été conçu pour ne jamais répondre sur le même ton, mais nous vous recommandons de consulter la conversation.`;

  const actionText = "Vous pouvez consulter cette conversation, et si nécessaire bloquer ce visiteur pour l'empêcher d'envoyer d'autres messages, depuis votre espace client :";

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1A1D1A;">
  <p style="font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: #8A6A3E; text-transform: uppercase; margin: 0 0 24px;">Proactif System</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">Bonjour,</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">${introText}</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">${actionText}</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;"><a href="${conversationUrl}" style="color: #8A6A3E;">${conversationUrl}</a></p>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0;">Ceci est une alerte automatique — aucune action n'a été prise sur votre compte, la décision de bloquer ce visiteur vous revient entièrement.</p>
</div>
`.trim();

  const text = [`Bonjour,`, "", introText, "", actionText, conversationUrl, "", "Ceci est une alerte automatique — aucune action n'a été prise sur votre compte, la décision de bloquer ce visiteur vous revient entièrement."].join("\n");

  return { subject, html, text };
}
