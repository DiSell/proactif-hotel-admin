import { createTransport } from "nodemailer";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "../types";

/**
 * Deliberately generic — no "IONOS" (or any other provider name) anywhere
 * in this type, in any variable name, or in any env var. The actual
 * host/port/credentials are pure runtime configuration; this file works
 * identically against any standard SMTP server. See getEmailProvider() in
 * ../provider.ts for how this gets selected.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

/**
 * Reads EMAIL_SMTP_HOST / EMAIL_SMTP_PORT / EMAIL_SMTP_USER /
 * EMAIL_SMTP_PASSWORD / EMAIL_FROM_ADDRESS / EMAIL_FROM_NAME from the
 * environment (see .env.example) — returns null the moment ANY required
 * value is missing or the port isn't a valid positive number, so the
 * caller falls back to the not-configured provider instead of building a
 * half-working transporter. EMAIL_FROM_NAME alone is optional (defaults to
 * "Proactif System") — every other field is required.
 */
export function readSmtpConfigFromEnv(): SmtpConfig | null {
  const host = process.env.EMAIL_SMTP_HOST;
  const portRaw = process.env.EMAIL_SMTP_PORT;
  const user = process.env.EMAIL_SMTP_USER;
  const password = process.env.EMAIL_SMTP_PASSWORD;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;
  const fromName = process.env.EMAIL_FROM_NAME?.trim() || "Proactif System";

  if (!host || !portRaw || !user || !password || !fromAddress) return null;

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) return null;

  return { host, port, user, password, fromAddress, fromName };
}

/**
 * Deterministic, no fallback: `secure` (implicit TLS at connection time,
 * e.g. port 465) is derived directly from whichever port is configured —
 * this module never tries a second port or a different TLS mode on
 * failure, and never silently switches from 465 to 587 or back. A
 * misconfigured port must surface as a clear connection/TLS error, not an
 * unpredictable automatic retry — see this task's own explicit requirement.
 */
function isImplicitTlsPort(port: number): boolean {
  return port === 465;
}

/**
 * Builds an EmailProvider backed by a real SMTP server via nodemailer —
 * the only package added for this (see providers/nodemailer.d.ts for why
 * no @types/nodemailer alongside it). Server-side only: this module is
 * only ever imported by provider.ts, itself only ever imported by
 * sendEmail.ts, itself only ever imported from "use server" Server Actions
 * (features/hotelUsers/actions.ts, features/auth/actions.ts) — nothing
 * here is reachable from a Client Component, so EMAIL_SMTP_PASSWORD is
 * never bundled into browser JS (no NEXT_PUBLIC_ prefix either way).
 *
 * NEVER logs: the password (never read anywhere below except into the
 * transport's own auth config, never into a log call), the recipient's
 * activation/reset link content, or any Supabase token — this provider
 * only ever sees whatever features/hotelUsers/actions.ts or
 * features/auth/actions.ts already built into the (subject, html, text)
 * it's asked to send, and doesn't log that content on success OR failure.
 * On failure, only the error's name/code/message are logged — the SMTP
 * protocol never echoes back credentials in an error response, so these
 * fields don't carry the password either.
 */
export function createSmtpProvider(config: SmtpConfig): EmailProvider {
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: isImplicitTlsPort(config.port),
    auth: { user: config.user, pass: config.password },
  });

  return {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      try {
        await transporter.sendMail({
          from: `"${config.fromName}" <${config.fromAddress}>`,
          to: input.to,
          subject: input.subject,
          html: input.html,
          text: input.text,
        });
        return { ok: true };
      } catch (err) {
        const error = err as Error & { code?: string };
        console.error("smtpProvider: send failed", { code: error.code, message: error.message });
        return { ok: false, error: "Le service d'envoi d'email a rencontré une erreur." };
      }
    },
  };
}
