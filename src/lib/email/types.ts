export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  ok: boolean;
  /** Safe to show in logs — never the provider's raw response body, never a secret, never a link/token. See provider.ts's own doc comment. */
  error?: string;
}

/**
 * Implemented by each concrete provider — no concrete provider is chosen
 * yet (see provider.ts's notConfiguredProvider). Feature code
 * (features/hotelUsers/actions.ts, features/auth/actions.ts) never imports
 * a concrete provider or this interface directly — only sendEmail()
 * (sendEmail.ts) — so wiring a real provider in later touches only
 * provider.ts, nothing in features/.
 */
export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}
