/**
 * Provider-agnostic contract for the WhatsApp transport layer. The
 * partner_requests domain (features/partnerRequests/, src/lib/notifications/
 * whatsapp/sendPartnerRequest.ts) depends ONLY on WhatsAppProvider — never
 * directly on `fetch` calls to graph.facebook.com or any other Meta-specific
 * shape. Swapping providers, or adding a second one behind an env-driven
 * switch, only ever touches provider.ts/metaProvider.ts.
 *
 * Mirrors the existing src/lib/email/ provider-abstraction pattern
 * (provider.ts / providers/smtp.ts / sendEmail.ts / types.ts) — same
 * "resolve fresh on every call, notConfiguredProvider as the safe default"
 * discipline.
 */

export type WhatsAppSendError =
  | "provider_not_configured"
  | "partner_not_eligible"
  | "missing_phone"
  | "invalid_phone"
  | "template_not_configured"
  | "request_not_found"
  | "request_not_eligible"
  /** Another delivery attempt for the same (hotel, partner_request, purpose) is already active — see 0023_partner_request_deliveries.sql's own partial unique index. Never call the provider when this is returned. */
  | "delivery_already_in_progress"
  /** A definitive 4xx rejection or a provable pre-connection transport failure. */
  | "provider_error"
  /** Acceptance cannot be excluded (5xx, incomplete 2xx, timeout, reset, or unclassified transport exception). */
  | "provider_unknown";

export type WhatsAppPreSendError = Exclude<WhatsAppSendError, "provider_error" | "provider_unknown">;

/**
 * Never carries a phone number, a token, a raw Meta payload, or any other
 * PII — see sendPartnerRequest.ts/metaProvider.ts's own logging discipline.
 * `providerMessageId` (Meta's own "wamid...") is not itself PII — it is an
 * opaque provider-assigned identifier, safe to log/return.
 */
export type WhatsAppSendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; error: WhatsAppPreSendError; attempted?: false }
  | { ok: false; error: "provider_error"; attempted: true; certainty: "not_sent" }
  | { ok: false; error: "provider_unknown"; attempted: true; certainty: "unknown" };

/**
 * A single WhatsApp template "quick reply" button — the template's approved
 * `label` is fixed at Meta's template-approval time (never composed here);
 * `payload` is the ONLY per-send-dynamic piece, and must always be an
 * OPAQUE, cryptographically random value carrying ZERO decodable
 * information (see replyToken.ts) — never a raw partner_request id, a
 * hotel_id, or anything derived from them, even encoded. Meta echoes
 * `payload` back verbatim in the webhook when the partner taps the button;
 * correlation happens exclusively via a server-side hash lookup against
 * partner_request_deliveries (0023_partner_request_deliveries.sql), never
 * by decoding the payload itself.
 */
export interface WhatsAppQuickReplyButton {
  label: string;
  payload: string;
}

/**
 * The abstract shape sendPartnerRequest.ts builds and hands to
 * WhatsAppProvider.sendTemplateMessage() — deliberately NOT free text (see
 * this module's own doc comment on why a template message, never a
 * free-text first contact, is required). `bodyParams` is a flat, ordered
 * list of the approved template's own positional variables — the exact
 * order/count depends on whichever template is eventually approved by Meta
 * (WHATSAPP_PARTNER_REQUEST_TEMPLATE); this type does not hardcode a
 * specific template's shape.
 */
export interface WhatsAppTemplateMessage {
  toE164: string;
  templateName: string;
  languageCode: string;
  bodyParams: string[];
  buttons: WhatsAppQuickReplyButton[];
}

/**
 * Only the ONE inbound shape this phase acts on — a template quick-reply
 * button tap. Every other inbound shape (free text, media, delivery-status
 * callbacks) deliberately parses to "unhandled": this phase never guesses
 * at freeform partner replies (see this module's own doc comment on
 * preferring deterministic buttons over LLM interpretation). Delivery-
 * status callbacks (sent/delivered/read/failed) are structurally prepared
 * for (partner_request_deliveries.provider_message_id is indexed for this)
 * but no handler consumes them yet — see 0023_partner_request_deliveries.sql's
 * own header comment.
 */
export type WhatsAppInboundEvent = { type: "button_reply"; payload: string; fromE164: string } | { type: "unhandled" };

export type WhatsAppWebhookParseResult = { ok: true; events: WhatsAppInboundEvent[] } | { ok: false; error: "invalid_signature" | "malformed_payload" };

export interface WhatsAppWebhookChallengeParams {
  mode: string | null;
  token: string | null;
  challenge: string | null;
}

export interface WhatsAppProvider {
  sendTemplateMessage(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult>;
  /** Returns the challenge string to echo back on a valid GET verification request, or null to reject (403). */
  verifyWebhookChallenge(params: WhatsAppWebhookChallengeParams): string | null;
  /** `rawBody` MUST be the exact, unparsed request body — Meta's signature is computed over the raw bytes, not a re-serialized JSON.stringify of a parsed object. */
  parseWebhookPayload(rawBody: string, signatureHeader: string | null): WhatsAppWebhookParseResult;
}
