import {
  parseMetaWebhookPayload,
  readMetaWebhookSignatureConfigFromEnv,
  readMetaWebhookVerifyConfigFromEnv,
  verifyMetaWebhookChallenge,
  type MetaWebhookSignatureConfig,
  type MetaWebhookVerifyConfig,
} from "./metaProvider";
import type { WhatsAppWebhookChallengeParams } from "./types";

/**
 * Pure orchestration — deliberately separate from
 * src/app/api/webhooks/whatsapp/route.ts itself so the actual
 * verification/parsing logic is testable without constructing a real
 * Next.js Request. The route file is a thin adapter over these two
 * functions (same "createXHandler(deps)" factory pattern already used by
 * src/app/api/widget/[widgetKey]/partner-request/phone/route.ts).
 *
 * DELIBERATELY does NOT go through getWhatsAppProvider() (provider.ts) —
 * that resolves the FULL send configuration (access token, phone number
 * id, app secret, API version all required together), which made the GET
 * handshake and the POST signature check impossible to satisfy during
 * initial Meta webhook setup, before the send-side credentials exist. GET
 * verification depends on WHATSAPP_META_VERIFY_TOKEN alone; POST signature
 * verification depends on WHATSAPP_META_APP_SECRET alone (never made
 * optional) — see metaProvider.ts's own doc comments on each reader.
 *
 * Deliberately stays DB-free and decode-free: reply tokens are opaque
 * (0023_partner_request_deliveries.sql) — there is nothing to decode here.
 * This module only verifies Meta's own signature and extracts the raw
 * button-tap token STRINGS; resolving a token to a partner_request +
 * command is a database lookup, owned by
 * features/partnerRequests/deliveryService.ts::resolvePartnerReplyToken,
 * called directly from route.ts.
 */

export interface WebhookDeps {
  /** Omit to read from the environment (readMetaWebhookVerifyConfigFromEnv) — pass explicitly only in tests. */
  verifyConfig?: MetaWebhookVerifyConfig | null;
  /** Omit to read from the environment (readMetaWebhookSignatureConfigFromEnv) — pass explicitly only in tests. */
  signatureConfig?: MetaWebhookSignatureConfig | null;
}

/** GET verification handshake (Meta's own subscription flow) — returns the challenge string to echo back, or null to reject with 403. Requires ONLY WHATSAPP_META_VERIFY_TOKEN (+ WHATSAPP_PROVIDER=meta) to be configured. */
export function handleWebhookChallenge(params: WhatsAppWebhookChallengeParams, deps: WebhookDeps = {}): string | null {
  const config = deps.verifyConfig !== undefined ? deps.verifyConfig : readMetaWebhookVerifyConfigFromEnv();
  return verifyMetaWebhookChallenge(params, config);
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
 * parseMetaWebhookPayload's own doc comment) — the route handler must read
 * it via `request.text()`, never `request.json()`, or Meta's signature
 * check will fail for every legitimate request too. Requires
 * WHATSAPP_META_APP_SECRET (+ WHATSAPP_PROVIDER=meta) — never optional,
 * never weakened.
 */
export function handleWebhookPost(rawBody: string, signatureHeader: string | null, deps: WebhookDeps = {}): WebhookPostOutcome {
  const config = deps.signatureConfig !== undefined ? deps.signatureConfig : readMetaWebhookSignatureConfigFromEnv();
  const parsed = parseMetaWebhookPayload(rawBody, signatureHeader, config);
  if (!parsed.ok) return { ok: false, reason: parsed.error, buttonTokens: [] };

  const buttonTokens = parsed.events.filter((event) => event.type === "button_reply").map((event) => event.payload);
  return { ok: true, buttonTokens };
}
