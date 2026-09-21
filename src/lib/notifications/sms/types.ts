/**
 * Provider-agnostic contract for the SMS transport layer — mirrors
 * lib/notifications/whatsapp/types.ts's own "the business domain depends
 * ONLY on this interface, never on a provider's own SDK/API shape" pattern
 * (src/lib/email/provider.ts uses the same discipline for email).
 *
 * PHASE 1 of the Twilio SMS integration: this module and its implementation
 * (twilioSmsProvider.ts) are entirely self-contained and NOT yet wired to
 * partner_requests/spa_bookings — see those modules' own deliveryService.ts
 * for the existing WhatsApp-based delivery lifecycle, unchanged by this
 * phase.
 *
 * Deliberately a SEPARATE interface from WhatsAppProvider, not a
 * generalization of it — SMS has no template/language/quick-reply-button
 * concept (WhatsApp Business Platform-specific), so forcing both transports
 * through one shape would mean synthesizing meaningless fields on one side.
 */

export type SmsSendError =
  | "provider_not_configured"
  /** A definitive 4xx rejection or a provable pre-connection transport failure. */
  | "provider_error"
  /** Acceptance cannot be excluded (5xx, incomplete 2xx, timeout, reset, or unclassified transport exception). */
  | "provider_unknown";

/**
 * Never carries a phone number or any other PII. `providerMessageId`
 * (Twilio's own MessageSid, "SM...") is not itself PII — it is an opaque
 * provider-assigned identifier, safe to log/return, same posture as Meta's
 * "wamid..." in WhatsAppSendResult.
 */
export type SmsSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: "provider_not_configured"; attempted?: false }
  | { ok: false; error: "provider_error"; attempted: true; certainty: "not_sent" }
  | { ok: false; error: "provider_unknown"; attempted: true; certainty: "unknown" };

export interface SmsMessage {
  toE164: string;
  body: string;
}

export interface SmsProvider {
  sendSms(message: SmsMessage): Promise<SmsSendResult>;
}
