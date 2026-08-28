import { randomBytes, createHash } from "node:crypto";

/**
 * Opaque reply tokens for the three WhatsApp quick-reply buttons
 * (Accepter/Refuser/Proposer une alternative) — carry ZERO decodable
 * information.
 *
 * REPLACES an earlier design (HMAC-signed base64url(JSON({partnerRequestId,
 * hotelId, command}))) that a design audit found to be signed but NOT
 * encrypted: the payload half was merely base64url-encoded — trivially
 * decodable by ANYONE without the signing secret, including Meta's own
 * infrastructure and the partner's own device. Signed ≠ confidential. This
 * file now generates plain, cryptographically random tokens instead —
 * there is nothing to decode because nothing is encoded.
 *
 * Correlation happens exclusively server-side, via a SHA-256 hash lookup
 * against partner_request_deliveries's own accept_reply_token_hash/
 * reject_reply_token_hash/propose_alternative_token_hash columns
 * (0023_partner_request_deliveries.sql — see
 * features/partnerRequests/deliveryService.ts::resolvePartnerReplyToken).
 *
 * Same generate-random/hash-only-storage discipline as every other
 * single-use token in this codebase (features/partners/consentToken.ts):
 * 256 bits of randomness, hex-encoded; only the SHA-256 hash is ever
 * persisted; the raw token exists only in memory during message
 * preparation and inside the button payload sent to Meta — never logged,
 * never stored, never returned to any caller beyond that one send.
 */
export interface PartnerReplyTokenPair {
  token: string;
  tokenHash: string;
}

export function generatePartnerReplyToken(): PartnerReplyTokenPair {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: hashPartnerReplyToken(token) };
}

/** Deterministic — used both when generating a new token and when hashing one received from an inbound WhatsApp button tap for the DB lookup. */
export function hashPartnerReplyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface PartnerReplyTokenSet {
  accept: PartnerReplyTokenPair;
  reject: PartnerReplyTokenPair;
  alternative: PartnerReplyTokenPair;
}

/** One call site for all three — guarantees three INDEPENDENT random tokens, never derived from one another or from any request/hotel identifier. */
export function generatePartnerReplyTokenSet(): PartnerReplyTokenSet {
  return { accept: generatePartnerReplyToken(), reject: generatePartnerReplyToken(), alternative: generatePartnerReplyToken() };
}
