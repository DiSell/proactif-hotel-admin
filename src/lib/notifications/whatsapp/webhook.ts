import { getWhatsAppProvider } from "./provider";
import type { WhatsAppProvider, WhatsAppWebhookChallengeParams } from "./types";

/**
 * Pure orchestration on top of WhatsAppProvider — deliberately separate
 * from src/app/api/webhooks/whatsapp/route.ts itself so the actual
 * signature-verification/parsing logic is testable without constructing a
 * real Next.js Request. The route file is a thin adapter over these two
 * functions (same "createXHandler(deps)" factory pattern already used by
 * src/app/api/widget/[widgetKey]/partner-request/phone/route.ts).
 *
 * Deliberately stays DB-free and decode-free: reply tokens are now OPAQUE
 * (0023_partner_request_deliveries.sql) — there is nothing to decode here
 * any more. This module only verifies Meta's own signature and extracts
 * the raw button-tap token STRINGS; resolving a token to a partner_request
 * + command is a database lookup, owned by
 * features/partnerRequests/deliveryService.ts::resolvePartnerReplyToken,
 * called directly from route.ts.
 */

export interface WebhookDeps {
  provider?: WhatsAppProvider;
}

/** GET verification handshake (Meta's own subscription flow) — returns the challenge string to echo back, or null to reject with 403. */
export function handleWebhookChallenge(params: WhatsAppWebhookChallengeParams, deps: WebhookDeps = {}): string | null {
  const provider = deps.provider ?? getWhatsAppProvider();
  return provider.verifyWebhookChallenge(params);
}

export interface WebhookPostOutcome {
  ok: boolean;
  reason?: "invalid_signature" | "malformed_payload";
  /**
   * The raw opaque token string from each signature-verified button-reply
   * event — every other event shape (free text, media, a delivery-status
   * callback) is dropped here, never surfaced. These are NOT yet resolved
   * to a partner_request/command — see route.ts, which passes each one to
   * deliveryService.ts::resolvePartnerReplyToken.
   */
  buttonTokens: string[];
}

/**
 * `rawBody` MUST be the raw, unparsed request body (see
 * WhatsAppProvider.parseWebhookPayload's own doc comment) — the route
 * handler must read it via `request.text()`, never `request.json()`, or
 * Meta's signature check will fail for every legitimate request too.
 */
export function handleWebhookPost(rawBody: string, signatureHeader: string | null, deps: WebhookDeps = {}): WebhookPostOutcome {
  const provider = deps.provider ?? getWhatsAppProvider();
  const parsed = provider.parseWebhookPayload(rawBody, signatureHeader);
  if (!parsed.ok) return { ok: false, reason: parsed.error, buttonTokens: [] };

  const buttonTokens = parsed.events.filter((event) => event.type === "button_reply").map((event) => event.payload);
  return { ok: true, buttonTokens };
}
