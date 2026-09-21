import { randomInt, createHash } from "node:crypto";

/**
 * Opaque, single, per-delivery SMS reply code — mirrors
 * whatsapp/replyToken.ts's own discipline (generate random, store only the
 * hash, correlate exclusively via a server-side hash lookup) with one
 * deliberate difference: WhatsApp generates one 256-bit token PER BUTTON
 * (accept/reject/alternative all independently unguessable); a human must
 * be able to type this one back from an SMS, so it is short — the digit
 * (1/2/3) typed alongside it, not the code itself, selects the command.
 * See 0042_sms_reply_correlation.sql's own header comment for why this is
 * a dedicated column/mechanism, never a reuse of the WhatsApp hash columns.
 *
 * Security posture (audited and explicitly validated this session, no
 * expiration/rate-limiting added beyond what was approved): 6 characters
 * from a 31-symbol alphabet excluding visually-ambiguous characters
 * (0/O, 1/I/L) ≈ 887 million combinations, combined with the delivery's
 * own status gate (sent/unknown only) and a mandatory From-number match
 * (see deliveryService.ts's own resolver functions) as the initial
 * protection — never the code's entropy alone.
 */

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 6;

export interface SmsReplyCodePair {
  code: string;
  codeHash: string;
}

/** Deterministic — used both when generating a new code and when hashing one received from an inbound SMS for the DB lookup. Normalizes internally (trim + uppercase) so a human-typed variant (lowercase, stray whitespace) still hashes identically to the code as generated. */
export function hashSmsReplyCode(code: string): string {
  return createHash("sha256").update(normalizeSmsReplyCode(code)).digest("hex");
}

export function normalizeSmsReplyCode(code: string): string {
  return code.trim().toUpperCase();
}

export function generateSmsReplyCode(): SmsReplyCodePair {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return { code, codeHash: hashSmsReplyCode(code) };
}
