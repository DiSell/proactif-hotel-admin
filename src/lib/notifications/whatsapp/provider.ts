import { createMetaWhatsAppProvider, readMetaConfigFromEnv } from "./metaProvider";
import type { WhatsAppProvider, WhatsAppSendResult, WhatsAppWebhookParseResult } from "./types";

/**
 * The safe default when no WhatsApp configuration is present at all (see
 * readMetaConfigFromEnv in metaProvider.ts — returns null the moment
 * WHATSAPP_PROVIDER isn't "meta" or any required WHATSAPP_META_* variable is
 * missing). Every sendPartnerRequest() call then safely resolves
 * { ok: false, error: "provider_not_configured" } instead of sending
 * anything or throwing — same discipline as src/lib/email/provider.ts's own
 * notConfiguredProvider.
 */
const notConfiguredProvider: WhatsAppProvider = {
  async sendTemplateMessage(): Promise<WhatsAppSendResult> {
    console.error("whatsAppProvider: no provider configured — message not sent");
    return { ok: false, error: "provider_not_configured" };
  },
  verifyWebhookChallenge(): string | null {
    console.error("whatsAppProvider: no provider configured — webhook verification refused");
    return null;
  },
  parseWebhookPayload(): WhatsAppWebhookParseResult {
    console.error("whatsAppProvider: no provider configured — webhook payload refused");
    return { ok: false, error: "invalid_signature" };
  },
};

/**
 * The single place that decides which concrete provider backs
 * sendPartnerRequest()/the webhook handlers. features/partnerRequests/
 * never imports metaProvider.ts or notConfiguredProvider directly, only
 * this function — adding a second provider later only ever touches this
 * file. Resolved fresh on every call (never cached at module scope), same
 * reasoning as getEmailProvider(): cheap, and a config change takes effect
 * on the very next call without restarting anything.
 */
export function getWhatsAppProvider(): WhatsAppProvider {
  const config = readMetaConfigFromEnv();
  if (config) return createMetaWhatsAppProvider(config);
  return notConfiguredProvider;
}

/** Resolve transport configuration before a delivery row is reserved. */
export function getConfiguredWhatsAppProvider(): WhatsAppProvider | null {
  const config = readMetaConfigFromEnv();
  return config ? createMetaWhatsAppProvider(config) : null;
}
