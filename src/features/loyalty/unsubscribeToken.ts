import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A stable, self-verifying (stateless) unsubscribe link for marketing
 * emails — deliberately NOT the hash-in-DB pattern used by
 * features/partners/consentToken.ts. That pattern fits a single-use,
 * "pending"-gated response; an unsubscribe link instead needs to stay valid
 * for as long as the recipient keeps the email (weeks, months), for every
 * marketing email a customer ever receives, without regenerating it (and
 * invalidating older, still-unread emails) on every send and without ever
 * storing a plaintext secret in the database. An HMAC over the customer id,
 * keyed by a server-only secret, gives exactly that: always re-derivable,
 * never persisted, and no database round trip needed to verify it.
 *
 * hotel_id is deliberately NOT embedded — the token only ever flips one
 * customer's own hotel_customers.customer_unsubscribed to true (see
 * unsubscribeActions.ts), never reveals or requires any cross-hotel
 * context, so there's nothing to scope beyond the customer id itself.
 */
function secret(): string | null {
  return process.env.LOYALTY_UNSUBSCRIBE_SECRET || null;
}

/** customerId is a UUID (hyphens only, never a dot) — safe to join/split on "." below. */
export function generateUnsubscribeToken(customerId: string): string | null {
  const key = secret();
  if (!key) return null;
  const signature = createHmac("sha256", key).update(customerId).digest("hex");
  return `${customerId}.${signature}`;
}

/** Returns the customer id the token was issued for, or null for a missing/tampered/forged token, or when the secret isn't configured. */
export function verifyUnsubscribeToken(token: string): string | null {
  const key = secret();
  if (!key) return null;

  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex === -1) return null;
  const customerId = token.slice(0, separatorIndex);
  const suppliedSignature = token.slice(separatorIndex + 1);

  const expectedSignature = createHmac("sha256", key).update(customerId).digest("hex");
  const a = Buffer.from(suppliedSignature, "hex");
  const b = Buffer.from(expectedSignature, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return customerId;
}
