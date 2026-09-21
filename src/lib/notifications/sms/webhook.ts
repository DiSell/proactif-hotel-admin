import { readTwilioWebhookSignatureConfigFromEnv, validateTwilioSignature, type TwilioWebhookSignatureConfig } from "./twilioSmsProvider";

/**
 * Pure orchestration — deliberately separate from
 * src/app/api/webhooks/twilio/sms/route.ts itself so the actual
 * verification/parsing logic is testable without constructing a real
 * Next.js Request. Mirrors whatsapp/webhook.ts's own
 * "route.ts is a thin adapter over these functions" pattern.
 *
 * PHASE 1: extraction only — MessageSid/From/To/Body are read out and
 * returned to the caller, but NOTHING is resolved against a delivery, no
 * reply-code lookup, no RPC. That correlation logic is a later, separate
 * phase (see this session's own preceding audits: reusing a WhatsApp reply
 * token hash column for an SMS code is explicitly NOT yet approved).
 */

export interface InboundSmsFields {
  messageSid: string;
  from: string;
  to: string;
  body: string;
}

export type InboundSmsOutcome = { ok: true; fields: InboundSmsFields } | { ok: false; reason: "invalid_signature" };

export interface SmsWebhookDeps {
  /** Omit to read from the environment (readTwilioWebhookSignatureConfigFromEnv). Pass explicitly only in tests. */
  signatureConfig?: TwilioWebhookSignatureConfig | null;
}

/**
 * `url` MUST be the exact public URL Twilio used to sign this request —
 * see resolvePublicRequestUrl below. `params` MUST be the exact parsed
 * form-urlencoded fields, unmodified (Twilio's signature is computed over
 * the sorted key/value pairs — see twilioSmsProvider.ts::validateTwilioSignature,
 * which delegates to the Twilio SDK's own validateRequest, never
 * reimplemented here).
 */
export function handleInboundSms(url: string, signatureHeader: string | null, params: Record<string, string>, deps: SmsWebhookDeps = {}): InboundSmsOutcome {
  const config = deps.signatureConfig !== undefined ? deps.signatureConfig : readTwilioWebhookSignatureConfigFromEnv();
  const valid = validateTwilioSignature(url, signatureHeader, params, config);
  if (!valid) return { ok: false, reason: "invalid_signature" };

  return {
    ok: true,
    fields: {
      messageSid: params.MessageSid ?? "",
      from: params.From ?? "",
      to: params.To ?? "",
      body: params.Body ?? "",
    },
  };
}

/**
 * Reconstructs the PUBLIC URL Twilio actually called, correcting for a
 * reverse proxy (e.g. Render) that terminates TLS before this app ever
 * sees the request — `request.url`'s own scheme/host can otherwise reflect
 * the proxy's internal connection (http://, an internal hostname) rather
 * than what Twilio signed (https://, the public hostname), which would
 * make EVERY legitimate request fail signature validation. `X-Forwarded-Proto`/
 * `X-Forwarded-Host` (falling back to `Host`) are trusted here ONLY to
 * rebuild the URL string handed to the Twilio SDK's own validator — they
 * are never used for anything else, and a missing header simply leaves
 * request.url's own scheme/host untouched.
 */
export function resolvePublicRequestUrl(request: Request): string {
  const url = new URL(request.url);

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwardedProto) url.protocol = `${forwardedProto}:`;

  const forwardedHost = (request.headers.get("x-forwarded-host") ?? request.headers.get("host"))?.split(",")[0]?.trim();
  if (forwardedHost) url.host = forwardedHost;

  return url.toString();
}
