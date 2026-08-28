import { createSmtpProvider, readSmtpConfigFromEnv } from "./providers/smtp";
import type { EmailProvider, SendEmailResult } from "./types";

/**
 * The safe default when no SMTP configuration is present at all (see
 * readSmtpConfigFromEnv in providers/smtp.ts — returns null the moment any
 * required EMAIL_SMTP_ variable or EMAIL_FROM_ADDRESS is missing). Every
 * sendEmail() call then safely resolves { ok: false, error: "Email
 * provider is not configured." } instead of sending anything or throwing.
 */
const notConfiguredProvider: EmailProvider = {
  async send(): Promise<SendEmailResult> {
    console.error("emailProvider: no provider configured — email not sent");
    return { ok: false, error: "Email provider is not configured." };
  },
};

/**
 * The single place that decides which concrete provider backs sendEmail()
 * — see sendEmail.ts, the only function feature code is allowed to call.
 * Feature code (features/hotelUsers/actions.ts, features/auth/actions.ts)
 * never imports providers/smtp.ts or notConfiguredProvider directly, only
 * sendEmail() — swapping the transport later (or adding a second provider
 * behind an env-driven switch) only ever touches this function.
 *
 * Resolved fresh on every call (never cached at module scope) — cheap
 * (readSmtpConfigFromEnv is a handful of process.env reads,
 * createTransport() doesn't open a connection by itself, only sendMail()
 * does) and means a config change takes effect on the very next send
 * without restarting anything.
 */
export function getEmailProvider(): EmailProvider {
  const smtpConfig = readSmtpConfigFromEnv();
  if (smtpConfig) return createSmtpProvider(smtpConfig);
  return notConfiguredProvider;
}
