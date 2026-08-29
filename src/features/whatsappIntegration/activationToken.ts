import { randomBytes, createHash } from "node:crypto";

/**
 * The hotel's WhatsApp Business owner has no auth.users row (never a
 * login-capable account in this app), so activation can't reuse
 * admin.auth.admin.generateLink()/verifyOtp() — this is its own
 * lightweight, single-purpose token. Same discipline as
 * features/partners/consentToken.ts, which this mirrors exactly.
 *
 * `token` (256 bits of randomness, hex-encoded) is embedded in the
 * generated activation URL and NEVER persisted anywhere — only
 * `hashActivationToken(token)` (SHA-256) is stored, in
 * hotel_whatsapp_activation_tokens.token_hash (0029). Never logged, never
 * sent to the LLM/RAG, never returned to a Client Component after the
 * moment of generation.
 */
export function generateActivationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashActivationToken(token) };
}

/** Deterministic — used both when generating a new token and when resolving one received from the public activation page's own [token] route param. */
export function hashActivationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
