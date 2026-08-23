import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Server-side half of the visitor session token scheme (see
 * PublicWidgetChat.tsx for the client half). The raw token is generated
 * client-side (crypto.getRandomValues, 256 bits) and NEVER reaches this
 * module or storage in raw form — only its SHA-256 hex digest does, stored
 * in conversations.session_id. This module never generates a token itself;
 * it only hashes what the client already generated and compares hashes.
 *
 * conversationId alone is never proof of possession — see the chat route,
 * which requires BOTH conversation.hotel_id === hotelId AND
 * sessionTokensMatch(conversation.session_id, hash(providedToken)) before
 * ever treating a conversationId as belonging to the caller.
 */

/** 64 lowercase hex chars = 32 bytes = 256 bits — exactly what the client generates. Rejects anything shorter, longer, or non-hex before it ever reaches a hash/compare. */
export const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Constant-time comparison — a naive `===` on two hashes leaks timing
 * information proportional to the number of matching leading characters,
 * which (however impractically) is exactly the kind of oracle an ownership
 * check must not offer. Returns false (never throws) for any malformed
 * input, including a length mismatch — crypto.timingSafeEqual itself throws
 * on unequal-length buffers, which would otherwise leak "closer to right
 * length" information through a different code path (a thrown exception
 * vs. a plain false).
 */
export function sessionTokensMatch(storedHash: string | null | undefined, providedTokenHash: string): boolean {
  if (!storedHash) return false;
  if (storedHash.length !== providedTokenHash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(storedHash, "utf8"), Buffer.from(providedTokenHash, "utf8"));
  } catch {
    return false;
  }
}
