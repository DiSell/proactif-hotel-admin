import Twilio from "twilio";
import type { SmsMessage, SmsProvider, SmsSendResult } from "./types";

/**
 * Official Twilio Programmable Messaging (SMS) adapter — PHASE 1 of the
 * Twilio SMS integration (see the preceding read-only audits this
 * session). This file is the ONLY place in the codebase allowed to
 * construct a Twilio REST client or call the Twilio SDK's send API.
 *
 * NOT YET WIRED to partner_requests/spa_bookings — see those domains' own
 * deliveryService.ts, unchanged by this phase. sendSms() is generic:
 * plain body text, no template/quick-reply concept (unlike
 * lib/notifications/whatsapp/metaProvider.ts, which is WhatsApp Business
 * Platform-specific).
 */
export interface TwilioSmsConfig {
  accountSid: string;
  authToken: string;
  from: string;
}

/**
 * Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_SMS_FROM from the
 * environment — returns null the moment any is missing, so the caller
 * falls back to a safe not-configured provider (provider.ts) instead of
 * building a half-working adapter. Same discipline as
 * whatsapp/metaProvider.ts::readMetaConfigFromEnv. Server-only variables —
 * no NEXT_PUBLIC_ prefix on any of them.
 */
export function readTwilioConfigFromEnv(): TwilioSmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM;

  if (!accountSid?.trim() || !authToken?.trim() || !from?.trim()) return null;
  return { accountSid, authToken, from };
}

/**
 * Decoupled from the full send config (accountSid/from) — same reasoning
 * as whatsapp/metaProvider.ts::readMetaWebhookSignatureConfigFromEnv:
 * inbound signature verification depends ONLY on the Auth Token, never on
 * whether outbound sending is fully configured yet.
 */
export interface TwilioWebhookSignatureConfig {
  authToken: string;
}

export function readTwilioWebhookSignatureConfigFromEnv(): TwilioWebhookSignatureConfig | null {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken?.trim()) return null;
  return { authToken };
}

/**
 * Wraps the SDK's own `Twilio.validateRequest` — NEVER reimplemented
 * manually (task's own explicit requirement). `url` MUST be the exact
 * public URL Twilio used to call this endpoint (scheme + host + path +
 * query) — see sms/webhook.ts::resolvePublicRequestUrl for reconstructing
 * it correctly behind a reverse proxy (Render) that may terminate TLS
 * before this app ever sees the request.
 */
export function validateTwilioSignature(url: string, signatureHeader: string | null, params: Record<string, string>, config: TwilioWebhookSignatureConfig | null): boolean {
  if (!config) return false;
  if (!signatureHeader) return false;
  return Twilio.validateRequest(config.authToken, signatureHeader, url, params);
}

function classifyTwilioError(err: unknown): { error: "provider_error"; certainty: "not_sent" } | { error: "provider_unknown"; certainty: "unknown" } {
  // A RestException carries the HTTP status Twilio itself returned — a
  // genuine 4xx rejection (invalid number, unverified trial recipient,
  // etc.) is a CERTAIN failure, never sent. Anything without an HTTP
  // status (network-level exception: DNS failure, timeout, connection
  // reset — no response was ever received) stays ambiguous, same
  // "attempted but unknown" posture as whatsapp/metaProvider.ts's own
  // fetch-based classification.
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return { error: "provider_error", certainty: "not_sent" };
  }
  return { error: "provider_unknown", certainty: "unknown" };
}

/**
 * PHASE 1: never exercised against the real network by any test in this
 * codebase — no test constructs a real TwilioSmsConfig with real
 * credentials, and nothing outside provider.ts's own (not-yet-activated)
 * resolution path calls createTwilioSmsProvider().
 */
export function createTwilioSmsProvider(config: TwilioSmsConfig): SmsProvider {
  const client = Twilio(config.accountSid, config.authToken);

  return {
    async sendSms(message: SmsMessage): Promise<SmsSendResult> {
      try {
        const result = await client.messages.create({ body: message.body, from: config.from, to: message.toE164 });
        return { ok: true, providerMessageId: result.sid };
      } catch (err) {
        // Never logs the error's own message/details: Twilio's RestException
        // message can echo back request content — same "never log the
        // provider response body" discipline as metaProvider.ts.
        console.error("twilioSmsProvider: send failed", { outcome: "classified_without_error_details" });
        const classified = classifyTwilioError(err);
        return { ok: false, attempted: true, ...classified };
      }
    },
  };
}
