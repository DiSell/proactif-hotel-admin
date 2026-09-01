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
}

function formatBookingDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "full" });
}

/**
 * Sent to chatbot_settings.handoff_email (fallback hotels.email) each time a
 * guest confirms a spa booking through the chatbot — see
 * features/spa/booking.ts:notifySpaBookingOwner. The booking is already
 * AUTO-CONFIRMED by the time this email is sent (no accept/reject step,
 * unlike partnerConsent.ts's own consent request) — this is a heads-up so
 * staff can be present, not a request for approval. Plain, professional, no
 * marketing — matches this project's existing transactional-email tone.
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
}: SpaBookingNotificationTemplateParams): EmailTemplate {
  const subject = `Nouvelle réservation spa — ${formatBookingDate(bookingDate)} à ${slotStart}`;

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
    Une réservation spa vient d'être confirmée via le chatbot de « ${hotelName} ». Merci de vous assurer qu'un membre de l'équipe soit présent pour accueillir le client au créneau indiqué.
  </p>
  <ul style="font-size: 14px; line-height: 1.8; margin: 0 0 16px; padding-left: 20px;">
    ${detailLines.map((line) => `<li>${line}</li>`).join("\n    ")}
  </ul>
  <p style="font-size: 12px; line-height: 1.6; color: #6b6b6b; margin: 0;">
    Cette réservation est automatiquement confirmée dès sa création par le client — cet email est une information, pas une demande d'approbation.
  </p>
</div>
`.trim();

  const text = [
    `Bonjour,`,
    "",
    `Une réservation spa vient d'être confirmée via le chatbot de « ${hotelName} ». Merci de vous assurer qu'un membre de l'équipe soit présent pour accueillir le client au créneau indiqué.`,
    "",
    ...detailLines.map((line) => `- ${line}`),
    "",
    "Cette réservation est automatiquement confirmée dès sa création par le client — cet email est une information, pas une demande d'approbation.",
  ].join("\n");

  return { subject, html, text };
}
