import type { EmailTemplate } from "../types";

export interface SpaBookingNotificationTemplateParams {
  hotelName: string;
  guestName: string | null;
  /** Already E.164 — never masked here: this email goes to the hotel's own staff, who need the real number to reach the guest, unlike the chat-facing recap shown to the guest (see features/partnerRequests/phoneRedaction.ts:maskPhoneForDisplay for that different context). */
  guestPhoneE164: string | null;
  partySize: number;
  /** "YYYY-MM-DD" */
  bookingDate: string;
  /** "HH:MM" */
  slotStart: string;
  isNonResident: boolean;
  notes: string | null;
  /**
   * "confirmed" (default behavior, hotel_spa_settings.approval_mode = "auto"):
   * the booking is already final — this email is informational only.
   * "pending_approval" (approval_mode = "manual", 0035_spa_booking_approval.sql):
   * the booking is NOT yet final — the hotel must confirm or refuse it (via
   * the WhatsApp Confirmer/Refuser buttons if configured, or the
   * Confirmer/Refuser buttons in /client/chatbot's "Réservations spa" list).
   * This email is sent in BOTH cases, as a fallback that never depends on
   * WhatsApp being configured or working.
   */
  status: "confirmed" | "pending_approval";
}

function formatBookingDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "full" });
}

/**
 * Sent to chatbot_settings.handoff_email (fallback hotels.email) each time a
 * guest requests a spa booking through the chatbot — see
 * features/spa/booking.ts:notifySpaBookingOwner. Two distinct messages
 * depending on `status`: "confirmed" (original, auto-confirm behavior — a
 * heads-up so staff can be present, never a request for approval) vs
 * "pending_approval" (0035_spa_booking_approval.sql's manual validation
 * mode — an explicit call to action, since this email may be the ONLY
 * notification the hotel gets if WhatsApp isn't configured yet). Plain,
 * professional, no marketing — matches this project's existing
 * transactional-email tone.
 */
export function spaBookingNotificationTemplate({
  hotelName,
  guestName,
  guestPhoneE164,
  partySize,
  bookingDate,
  slotStart,
  isNonResident,
  notes,
  status,
}: SpaBookingNotificationTemplateParams): EmailTemplate {
  const isPending = status === "pending_approval";
  const subject = isPending
    ? `Réservation spa à valider — ${formatBookingDate(bookingDate)} à ${slotStart}`
    : `Nouvelle réservation spa — ${formatBookingDate(bookingDate)} à ${slotStart}`;

  const introText = isPending
    ? `Une demande de réservation spa attend votre validation pour « ${hotelName} ». Confirmez ou refusez-la depuis WhatsApp (si configuré) ou depuis la liste « Réservations spa » de votre espace client.`
    : `Une réservation spa vient d'être confirmée via le chatbot de « ${hotelName} ». Merci de vous assurer qu'un membre de l'équipe soit présent pour accueillir le client au créneau indiqué.`;

  const footerText = isPending
    ? "Cette réservation N'EST PAS encore confirmée : le client attend votre décision."
    : "Cette réservation est automatiquement confirmée dès sa création par le client — cet email est une information, pas une demande d'approbation.";

  const detailLines = [
    `Date : ${formatBookingDate(bookingDate)}`,
    `Créneau : ${slotStart}`,
    `Nombre de personnes : ${partySize}`,
    `Client : ${guestName ?? "non communiqué"}`,
    `Téléphone : ${guestPhoneE164 ?? "non communiqué"}`,
    `Client extérieur (non résident) : ${isNonResident ? "oui" : "non"}`,
    notes ? `Note du client : ${notes}` : null,
  ].filter((line): line is string => Boolean(line));

  const html = `
<div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px; color: #1A1D1A;">
  <p style="font-size: 13px; font-weight: 600; letter-spacing: 0.04em; color: #8A6A3E; text-transform: uppercase; margin: 0 0 24px;">Proactif System</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">Bonjour,</p>
  <p style="font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
    ${introText}
  </p>
  <ul style="font-size: 14px; line-height: 1.8; margin: 0 0 16px; padding-left: 20px;">
    ${detailLines.map((line) => `<li>${line}</li>`).join("\n    ")}
  </ul>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0;">
    ${footerText}
  </p>
</div>
`.trim();

  const text = [`Bonjour,`, "", introText, "", ...detailLines.map((line) => `- ${line}`), "", footerText].join("\n");

  return { subject, html, text };
}
