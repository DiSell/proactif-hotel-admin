import { randomBytes, createHash } from "node:crypto";

/**
 * The partner has no auth.users row (never a login-capable account in this
 * app), so the consent flow can't reuse admin.auth.admin.generateLink()/
 * verifyOtp() — this is its own lightweight, single-purpose token.
 *
 * `token` (256 bits of randomness, hex-encoded) is embedded in the emailed
 * confirmation URL and NEVER persisted anywhere — only `hashConsentToken(token)`
 * (SHA-256) is stored, in hotel_partners.consent_token_hash
 * (0017_hotel_partner_consent.sql). Same discipline as every other secret
 * in this codebase: never logged, never returned to a Client Component.
 */
export function generateConsentToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashConsentToken(token) };
}

/** Deterministic — used both when generating a new token and when validating one received from the public confirmation page's own query param. */
export function hashConsentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
