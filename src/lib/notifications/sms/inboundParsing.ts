import { normalizeSmsReplyCode } from "./smsReplyCode";

/**
 * Deterministic, domain-agnostic parsing of an inbound SMS Body into
 * `<digit> <code> [free text]` — the ONLY place this shape is interpreted.
 * NEVER delegated to the model: a reply that controls a real business
 * transition (accept/reject/approve a booking) must be resolved the same
 * way every time, not "probably" understood by an LLM (task's own explicit
 * requirement — mirrors why WhatsApp button taps are matched by exact
 * opaque payload, never by guessing at free text).
 *
 * Deliberately has NO knowledge of partner vs spa — digit 3 (alternative)
 * is only meaningful for partner requests, but that domain mapping (and
 * the resulting business command) is decided by the caller
 * (features/partnerRequests/deliveryService.ts /
 * features/spa/deliveryService.ts), never here.
 */

export interface ParsedInboundSms {
  digit: "1" | "2" | "3";
  /** Normalized (trimmed + uppercased) — matches smsReplyCode.ts's own normalization exactly, so hashSmsReplyCode(parsed.code) always matches the code as generated. */
  code: string;
  /** Trimmed, non-empty when present. Only ever meaningful for digit "3" — callers for digit "1"/"2" must ignore it even if a human typed trailing text anyway. */
  freeText: string | null;
}

// <digit 1-3>, at least one whitespace, one non-whitespace token (the code),
// optionally more whitespace then any remaining text (the free-form
// alternative). Anchored at both ends — a message that doesn't start with
// exactly "<digit> <code>" is not a reply to this system at all.
const INBOUND_SMS_PATTERN = /^([123])\s+(\S+)(?:\s+([\s\S]+))?$/;

export function parseInboundSmsBody(body: string): ParsedInboundSms | null {
  const match = body.trim().match(INBOUND_SMS_PATTERN);
  if (!match) return null;

  const [, digit, rawCode, rawFreeText] = match;
  const freeText = rawFreeText?.trim();

  return {
    digit: digit as "1" | "2" | "3",
    code: normalizeSmsReplyCode(rawCode),
    freeText: freeText && freeText.length > 0 ? freeText : null,
  };
}
