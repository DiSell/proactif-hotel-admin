/**
 * Free-text safety net ONLY — the primary path for collecting a guest's
 * phone number is (and will remain) a dedicated structured widget field,
 * never the model parsing free chat text (see the validated plan). This
 * module exists purely so that if a guest spontaneously types their number
 * into a normal message, the raw digits never reach the model: every
 * caller MUST run the full text about to be sent as model input (and, per
 * the plan, the text persisted to `messages.content`) through
 * redactPhoneNumbers() first.
 *
 * Deliberately narrow pattern matching, not "any run of digits" — the two
 * patterns below are shaped specifically to exclude dates, times, prices,
 * room numbers, and booking codes by STRUCTURE (group count/size, required
 * prefix), not by a blocklist of known false positives:
 *
 * - A French national number has exactly 5 groups of 2 digits, the first
 *   digit of the first group is always "0" (0X XX XX XX XX) — a date like
 *   "28-08-2026" is only 3 groups (2/2/4 digits) and never matches this
 *   shape at all, regardless of separator.
 * - An international number starts with "+" followed by a country code —
 *   nothing else in ordinary hotel-chat text (times, prices, room numbers,
 *   booking codes) is ever written with a leading "+".
 *
 * Favors false negatives over false positives, per the validated plan: a
 * real phone number missed here is recoverable (the structured field still
 * collects it later); a room number or booking code wrongly redacted would
 * corrupt legitimate content for no security benefit.
 *
 * Pure — no I/O, no logging. Callers must never log a raw detectedPhone/
 * normalizedPhoneE164 value; this module simply never gives them a reason
 * to, since it does no logging itself.
 */

export interface PhoneRedactionResult {
  /** The input text with every detected phone-like match replaced by a redaction placeholder — this is what may ever reach the model or be persisted. */
  sanitizedText: string;
  /** The first detected match, exactly as written in the original text (e.g. "06 67 59 42 98") — null if nothing plausible was found. */
  detectedPhone: string | null;
  /**
   * Best-effort E.164 form of detectedPhone, only when the match itself
   * carries enough information to derive it with confidence — a "+"-led
   * match already states its own country code (only separators are
   * stripped); a French national match (leading 0, 10 digits) is
   * deterministically mapped to +33 per the French numbering plan itself,
   * not a guess. Null whenever normalization would require inventing a
   * country/indicatif that isn't actually present in the text.
   */
  normalizedPhoneE164: string | null;
}

const REDACTION_PLACEHOLDER = "[numéro retiré]";

// Exactly 5 groups of 2 digits, first group starting with a non-zero digit
// after the leading 0 — the French national mobile/landline shape. Lookarounds
// keep this from matching inside a longer run of digits (e.g. a longer
// reference number that happens to contain a matching substring).
const FR_NATIONAL_PATTERN = /(?<!\d)0[1-9](?:[ .-]?\d{2}){4}(?!\d)/g;

// A leading "+" followed by 1-3 digits (country code) then 1-5 more groups
// of 1-4 digits — deliberately loose on group size (a French international
// number is conventionally written "+33 6 67 59 42 98", with a lone single
// digit right after the country code) and relies on the overall 8-15 digit
// count below, plus the mandatory literal "+" (never present in a date,
// time, price, room number, or booking code), to stay precise.
const INTL_PATTERN = /(?<!\d)\+\d{1,3}(?:[ .-]?\d{1,4}){1,5}(?!\d)/g;

// Non-global, fully-anchored twin of FR_NATIONAL_PATTERN, used only to
// classify an already-extracted candidate — deliberately a SEPARATE regex
// object (not a re-use of the global one above with lastIndex juggling)
// since a global regex's statefulness across .test() calls is a classic
// source of intermittent bugs.
const FR_NATIONAL_PATTERN_EXACT = /^0[1-9](?:[ .-]?\d{2}){4}$/;

// Non-global, fully-anchored twin of INTL_PATTERN, same reasoning as
// FR_NATIONAL_PATTERN_EXACT above — used by normalizeStructuredPhoneInput
// to validate a WHOLE structured form field (never a substring embedded in
// surrounding free text, unlike INTL_PATTERN's own use in findCandidates).
const INTL_PATTERN_EXACT = /^\+\d{1,3}(?:[ .-]?\d{1,4}){1,5}$/;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function findCandidates(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of [FR_NATIONAL_PATTERN, INTL_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // A genuine phone number has 8-15 significant digits (ITU E.164
      // bounds) — this rejects any accidental over/under-match the
      // group-repetition pattern alone wouldn't catch.
      const digitCount = digitsOnly(match[0]).length;
      if (digitCount >= 8 && digitCount <= 15) matches.push(match[0]);
    }
  }
  return matches;
}

function normalize(rawMatch: string): string | null {
  if (rawMatch.startsWith("+")) {
    return `+${digitsOnly(rawMatch)}`;
  }
  if (FR_NATIONAL_PATTERN_EXACT.test(rawMatch)) {
    // Deterministic French numbering-plan rule (drop the trunk "0", prefix
    // +33) — not an arbitrary country guess: this shape ONLY ever means a
    // French national number.
    return `+33${digitsOnly(rawMatch).slice(1)}`;
  }
  return null;
}

export function redactPhoneNumbers(text: string): PhoneRedactionResult {
  const candidates = findCandidates(text);

  let sanitizedText = text;
  for (const candidate of candidates) {
    sanitizedText = sanitizedText.split(candidate).join(REDACTION_PLACEHOLDER);
  }

  const detectedPhone = candidates[0] ?? null;
  const normalizedPhoneE164 = detectedPhone ? normalize(detectedPhone) : null;

  return { sanitizedText, detectedPhone, normalizedPhoneE164 };
}

/**
 * Structured widget phone form ONLY — validates/normalizes a WHOLE field
 * value (e.g. "06 12 34 56 78" or "+33 6 12 34 56 78"), never a substring
 * scan like redactPhoneNumbers() above. Same two shapes, same "never invent
 * a country code for an ambiguous format" discipline: a value matching
 * neither the anchored FR national shape nor the anchored international
 * shape returns null — the caller (the phone-collection endpoint) must
 * then show a readable error and write nothing, never guess.
 */
export function normalizeStructuredPhoneInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (INTL_PATTERN_EXACT.test(trimmed)) {
    const digits = digitsOnly(trimmed);
    // Same ITU E.164 bounds as findCandidates() above.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (FR_NATIONAL_PATTERN_EXACT.test(trimmed)) {
    return `+33${digitsOnly(trimmed).slice(1)}`;
  }
  return null;
}

/**
 * Display-only masking for a chatbot recap shown back to the guest BEFORE
 * they confirm a partner request (never the raw number) — distinct from
 * redactPhoneNumbers() above, which sanitizes text for persistence/the
 * model. Keeps the leading country code (2 digits) and the last 2 digits
 * visible, masks everything in between — e.g. "+33612345678" ->
 * "+33 *******78". Input must already be a valid E.164 value (leading "+");
 * never called with a raw/unnormalized number.
 */
export function maskPhoneForDisplay(e164: string): string {
  const digits = e164.replace(/^\+/, "");
  if (digits.length <= 4) return `+${"*".repeat(digits.length)}`;
  const countryCode = digits.slice(0, 2);
  const lastTwo = digits.slice(-2);
  const maskedCount = digits.length - 4;
  return `+${countryCode} ${"*".repeat(maskedCount)}${lastTwo}`;
}
