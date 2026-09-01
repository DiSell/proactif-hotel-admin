import { randomBytes, createHash } from "node:crypto";

/**
 * Opaque reply tokens for the two spa-booking-approval WhatsApp buttons
 * (Confirmer/Refuser) — carries ZERO decodable information, same discipline
 * as replyToken.ts (partner requests). A separate module, not a shared
 * import, so the spa and partner domains stay independent (mirrors
 * features/rag/confirmation.ts's own reasoning for isExplicitConfirmation) —
 * the underlying primitive (32 random bytes, SHA-256 hash) is intentionally
 * duplicated rather than shared, since the two token spaces must never be
 * confusable and there is no real cost to a few duplicated lines.
 *
 * Correlation happens exclusively server-side, via a SHA-256 hash lookup
 * against spa_booking_deliveries's own accept_reply_token_hash/
 * reject_reply_token_hash columns (0035_spa_booking_approval.sql — see
 * features/spa/deliveryService.ts::resolveSpaBookingReplyToken).
 */
export interface SpaBookingReplyTokenPair {
  token: string;
  tokenHash: string;
}

export function generateSpaBookingReplyToken(): SpaBookingReplyTokenPair {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashSpaBookingReplyToken(token) };
}

/** Deterministic — used both when generating a new token and when hashing one received from an inbound WhatsApp button tap for the DB lookup. */
export function hashSpaBookingReplyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SpaBookingReplyTokenSet {
  accept: SpaBookingReplyTokenPair;
  reject: SpaBookingReplyTokenPair;
}

/** One call site for both — guarantees two INDEPENDENT random tokens, never derived from one another or from any booking/hotel identifier. */
export function generateSpaBookingReplyTokenSet(): SpaBookingReplyTokenSet {
  return { accept: generateSpaBookingReplyToken(), reject: generateSpaBookingReplyToken() };
}
