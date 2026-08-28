import { createHmac, timingSafeEqual } from "node:crypto";
import type { WhatsAppInboundEvent, WhatsAppProvider, WhatsAppSendResult, WhatsAppTemplateMessage, WhatsAppWebhookParseResult } from "./types";

/**
 * Official Meta WhatsApp Business Platform / Cloud API adapter. NEVER
 * imported by features/partnerRequests/ directly — only by provider.ts,
 * itself only reachable through getWhatsAppProvider(). This file is the
 * ONLY place in the codebase allowed to reference graph.facebook.com.
 *
 * Deliberately generic naming inside the type (WhatsAppProvider), same
 * discipline as src/lib/email/providers/smtp.ts's own comment on avoiding a
 * provider-specific name leaking into the shared abstraction.
 */
export interface MetaWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  verifyToken: string;
  appSecret: string;
  apiVersion: string;
}

/**
 * Reads WHATSAPP_PROVIDER / WHATSAPP_META_ACCESS_TOKEN /
 * WHATSAPP_META_PHONE_NUMBER_ID / WHATSAPP_META_VERIFY_TOKEN /
 * WHATSAPP_META_APP_SECRET / WHATSAPP_META_API_VERSION from the environment
 * (see .env.example) — returns null the moment WHATSAPP_PROVIDER isn't
 * exactly "meta" or ANY of the other five is missing, so the caller falls
 * back to the not-configured provider (provider.ts) instead of building a
 * half-working adapter. Every one of these is a SERVER-only variable — no
 * NEXT_PUBLIC_ prefix on any of them, checked by env.test.ts.
 */
export function readMetaConfigFromEnv(): MetaWhatsAppConfig | null {
  if (process.env.WHATSAPP_PROVIDER !== "meta") return null;

  const accessToken = process.env.WHATSAPP_META_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_META_PHONE_NUMBER_ID;
  const verifyToken = process.env.WHATSAPP_META_VERIFY_TOKEN;
  const appSecret = process.env.WHATSAPP_META_APP_SECRET;
  const apiVersion = process.env.WHATSAPP_META_API_VERSION;

  if (!accessToken?.trim() || !phoneNumberId?.trim() || !verifyToken?.trim() || !appSecret?.trim() || !apiVersion?.trim()) return null;
  if (!/^\d+$/.test(phoneNumberId) || !/^v\d+\.\d+$/.test(apiVersion)) return null;
  return { accessToken, phoneNumberId, verifyToken, appSecret, apiVersion };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Meta's official Cloud API request shape for a template message with quick-reply buttons — see https://developers.facebook.com/docs/whatsapp/cloud-api. */
function buildMetaTemplatePayload(message: WhatsAppTemplateMessage): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: message.toE164.replace(/^\+/, ""),
    type: "template",
    template: {
      name: message.templateName,
      language: { code: message.languageCode },
      components: [
        { type: "body", parameters: message.bodyParams.map((text) => ({ type: "text", text })) },
        ...message.buttons.map((button, index) => ({
          type: "button",
          sub_type: "quick_reply",
          index: String(index),
          parameters: [{ type: "payload", payload: button.payload }],
        })),
      ],
    },
  };
}

/**
 * Extracts ONLY template quick-reply button taps from a webhook payload —
 * every other shape (free text, media, delivery-status callbacks) parses to
 * "unhandled", never guessed at (see types.ts's own doc comment on why).
 * Returns null ONLY when the payload's own top-level `entry` shape cannot
 * be read at all — a malformed/foreign payload, not a recognized-but-
 * unhandled event.
 */
function extractInboundEvents(json: unknown): WhatsAppInboundEvent[] | null {
  if (typeof json !== "object" || json === null) return null;
  const entries = (json as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return null;

  const events: WhatsAppInboundEvent[] = [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown })?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = (change as { value?: { messages?: unknown } })?.value?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        const button = (message as { button?: { payload?: unknown } })?.button;
        const from = (message as { from?: unknown })?.from;
        if (button && typeof button.payload === "string" && typeof from === "string") {
          events.push({ type: "button_reply", payload: button.payload, fromE164: `+${from}` });
        } else {
          events.push({ type: "unhandled" });
        }
      }
    }
  }
  return events;
}

/**
 * POINT CRITIQUE (task section 5): the fetch() call below is NEVER exercised
 * against the real network during this task — no test constructs a real
 * MetaWhatsAppConfig with real credentials, and nothing in this codebase
 * calls createMetaWhatsAppProvider() outside of provider.ts's own
 * (currently never-configured-in-this-task) resolution path.
 */
export function createMetaWhatsAppProvider(config: MetaWhatsAppConfig): WhatsAppProvider {
  return {
    async sendTemplateMessage(message: WhatsAppTemplateMessage): Promise<WhatsAppSendResult> {
      // Only 4xx rejections and provable pre-connection failures are
      // certainly not sent. Server errors, incomplete success responses,
      // timeouts and post-write network failures stay ambiguous.
      try {
        const response = await fetch(`https://graph.facebook.com/${config.apiVersion}/${config.phoneNumberId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(buildMetaTemplatePayload(message)),
        });

        const json = (await response.json().catch(() => null)) as { messages?: { id?: unknown }[] } | null;
        const rawMessageId = json?.messages?.[0]?.id;
        const providerMessageId = typeof rawMessageId === "string" && rawMessageId.startsWith("wamid.") ? rawMessageId : null;
        if (!response.ok || !providerMessageId) {
          // Never logs the response body: it may echo back the request
          // payload (including the destination phone number).
          console.error("metaWhatsAppProvider: send failed", { status: response.status });
          if (response.status >= 400 && response.status < 500) {
            return { ok: false, error: "provider_error", attempted: true, certainty: "not_sent" };
          }
          return { ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" };
        }
        return { ok: true, providerMessageId };
      } catch (err) {
        console.error("metaWhatsAppProvider: transport exception", { outcome: "classified_without_error_details" });
        const code = networkErrorCode(err);
        if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED") {
          return { ok: false, error: "provider_error", attempted: true, certainty: "not_sent" };
        }
        return { ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" };
      }
    },

    verifyWebhookChallenge({ mode, token, challenge }): string | null {
      if (mode !== "subscribe" || !token || !challenge) return null;
      if (!timingSafeStringEqual(token, config.verifyToken)) return null;
      return challenge;
    },

    parseWebhookPayload(rawBody: string, signatureHeader: string | null): WhatsAppWebhookParseResult {
      if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return { ok: false, error: "invalid_signature" };

      const expected = createHmac("sha256", config.appSecret).update(rawBody).digest("hex");
      const provided = signatureHeader.slice("sha256=".length);
      if (!timingSafeStringEqual(expected, provided)) return { ok: false, error: "invalid_signature" };

      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        return { ok: false, error: "malformed_payload" };
      }

      const events = extractInboundEvents(json);
      if (events === null) return { ok: false, error: "malformed_payload" };
      return { ok: true, events };
    },
  };
}

function networkErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? cause.code : null;
}
