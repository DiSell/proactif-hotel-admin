import { createTwilioSmsProvider, readTwilioConfigFromEnv } from "./twilioSmsProvider";
import type { SmsProvider, SmsSendResult } from "./types";

/**
 * The safe default when no SMS configuration is present at all — every
 * sendSms() call then safely resolves { ok: false, error:
 * "provider_not_configured" } instead of sending anything or throwing.
 * Mirrors whatsapp/provider.ts::notConfiguredProvider exactly.
 */
const notConfiguredProvider: SmsProvider = {
  async sendSms(): Promise<SmsSendResult> {
    console.error("smsProvider: no provider configured — message not sent");
    return { ok: false, error: "provider_not_configured" };
  },
};

/**
 * The single place that decides which concrete provider backs sendSms()
 * callers. Resolved fresh on every call (never cached at module scope) —
 * same reasoning as whatsapp/provider.ts::getWhatsAppProvider: a config
 * change takes effect on the very next call without restarting anything.
 *
 * PHASE 1: nothing outside this module and its own tests calls
 * getSmsProvider()/getConfiguredSmsProvider() yet — not wired to
 * partner_requests/spa_bookings.
 */
export function getSmsProvider(): SmsProvider {
  const config = readTwilioConfigFromEnv();
  if (config) return createTwilioSmsProvider(config);
  return notConfiguredProvider;
}

/** Resolve transport configuration before a delivery row is reserved — mirrors whatsapp/provider.ts::getConfiguredWhatsAppProvider. */
export function getConfiguredSmsProvider(): SmsProvider | null {
  const config = readTwilioConfigFromEnv();
  return config ? createTwilioSmsProvider(config) : null;
}
