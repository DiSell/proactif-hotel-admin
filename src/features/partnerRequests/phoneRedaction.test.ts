import { describe, expect, it } from "vitest";
import { maskPhoneForDisplay, normalizeStructuredPhoneInput, redactPhoneNumbers } from "./phoneRedaction";

describe("redactPhoneNumbers — false positives (must NOT be treated as a phone number)", () => {
  it.each([
    "le 28/08/2026",
    "28-08-2026",
    "à 19h30",
    "à 20:45",
    "120 €",
    "149,90 EUR",
    "chambre 204",
    "réservation AB12345",
  ])('"%s" is left untouched, no phone detected', (text) => {
    const result = redactPhoneNumbers(text);
    expect(result.detectedPhone).toBeNull();
    expect(result.normalizedPhoneE164).toBeNull();
    expect(result.sanitizedText).toBe(text);
  });

  it("[combined sentence] a realistic message mixing several false-positive shapes stays fully untouched", () => {
    const text = "Réservation AB12345, chambre 204, arrivée le 28/08/2026 à 19h30, total 149,90 EUR.";
    const result = redactPhoneNumbers(text);
    expect(result.detectedPhone).toBeNull();
    expect(result.sanitizedText).toBe(text);
  });
});

describe("redactPhoneNumbers — true positives (plausible phone formats)", () => {
  it("[FR, spaces] \"06 67 59 42 98\" is detected and normalized to +33667594298", () => {
    const result = redactPhoneNumbers("Mon numéro est 06 67 59 42 98, rappelez-moi.");
    expect(result.detectedPhone).toBe("06 67 59 42 98");
    expect(result.normalizedPhoneE164).toBe("+33667594298");
    expect(result.sanitizedText).toBe("Mon numéro est [numéro retiré], rappelez-moi.");
  });

  it("[FR, dots] \"06.67.59.42.98\" is detected and normalized", () => {
    const result = redactPhoneNumbers("06.67.59.42.98");
    expect(result.detectedPhone).toBe("06.67.59.42.98");
    expect(result.normalizedPhoneE164).toBe("+33667594298");
  });

  it("[FR, dashes] \"06-67-59-42-98\" is detected and normalized", () => {
    const result = redactPhoneNumbers("06-67-59-42-98");
    expect(result.detectedPhone).toBe("06-67-59-42-98");
    expect(result.normalizedPhoneE164).toBe("+33667594298");
  });

  it("[FR, no separator] \"0667594298\" is detected and normalized", () => {
    const result = redactPhoneNumbers("0667594298");
    expect(result.detectedPhone).toBe("0667594298");
    expect(result.normalizedPhoneE164).toBe("+33667594298");
  });

  it("[international, +33 with lone leading digit] \"+33 6 67 59 42 98\" is detected and normalized", () => {
    const result = redactPhoneNumbers("+33 6 67 59 42 98");
    expect(result.detectedPhone).toBe("+33 6 67 59 42 98");
    expect(result.normalizedPhoneE164).toBe("+33667594298");
  });

  it("[international, generic +1] \"+1 415 555 2671\" is detected, normalized by stripping separators only (never guessing a different country)", () => {
    const result = redactPhoneNumbers("+1 415 555 2671");
    expect(result.detectedPhone).toBe("+1 415 555 2671");
    expect(result.normalizedPhoneE164).toBe("+14155552671");
  });

  it("[sanitizedText] the placeholder replaces the number, the rest of the sentence is untouched", () => {
    const result = redactPhoneNumbers("Vous pouvez me joindre au +33 6 67 59 42 98 après 18h.");
    expect(result.sanitizedText).toBe("Vous pouvez me joindre au [numéro retiré] après 18h.");
  });
});

describe("redactPhoneNumbers — never invents a country code", () => {
  it("[FR national shape] normalization is deterministic (+33), not an arbitrary guess — documented reasoning, verified behavior", () => {
    // The French numbering plan makes "0X XX XX XX XX" unambiguous: this is
    // NOT a guess among many possible countries, it's the only country this
    // shape can mean. Re-asserted here explicitly since it's the one case
    // where this module infers anything at all.
    expect(redactPhoneNumbers("06 12 34 56 78").normalizedPhoneE164).toBe("+33612345678");
  });

  it("[no leading + and not a recognizable FR shape] never normalized, even if it superficially looks digit-heavy", () => {
    // 9 digits, not 10 — doesn't match the FR national shape, and has no
    // "+" — nothing here justifies inventing a country code.
    const result = redactPhoneNumbers("123456789");
    expect(result.detectedPhone).toBeNull();
    expect(result.normalizedPhoneE164).toBeNull();
  });
});

describe("redactPhoneNumbers — no detection, no-op", () => {
  it("[no candidate] plain text with no phone-like sequence returns the input unchanged", () => {
    const text = "Bonjour, avez-vous une table disponible ce soir ?";
    const result = redactPhoneNumbers(text);
    expect(result).toEqual({ sanitizedText: text, detectedPhone: null, normalizedPhoneE164: null });
  });

  it("[empty string]", () => {
    expect(redactPhoneNumbers("")).toEqual({ sanitizedText: "", detectedPhone: null, normalizedPhoneE164: null });
  });
});

describe("maskPhoneForDisplay — never the raw number, but never fully hidden either", () => {
  it("[typical FR E.164] keeps the country code and last 2 digits, masks everything else", () => {
    const masked = maskPhoneForDisplay("+33612345678");
    expect(masked).toBe("+33 *******78");
  });

  it("[never contains the full raw number]", () => {
    const raw = "+33612345678";
    const masked = maskPhoneForDisplay(raw);
    expect(masked).not.toBe(raw);
    expect(masked).not.toContain("612345");
  });

  it("[always starts with + and the same country code as the input]", () => {
    expect(maskPhoneForDisplay("+33612345678").startsWith("+33")).toBe(true);
    expect(maskPhoneForDisplay("+14155552671").startsWith("+14")).toBe(true);
  });

  it("[very short input] never throws, degrades gracefully instead of masking a negative length", () => {
    expect(() => maskPhoneForDisplay("+123")).not.toThrow();
  });
});

describe("normalizeStructuredPhoneInput — the widget's structured phone field, a whole value, never a substring scan", () => {
  it("[FR national plausible] normalized to +33, with common separators/spacing", () => {
    expect(normalizeStructuredPhoneInput("0612345678")).toBe("+33612345678");
    expect(normalizeStructuredPhoneInput("06 12 34 56 78")).toBe("+33612345678");
    expect(normalizeStructuredPhoneInput("06.12.34.56.78")).toBe("+33612345678");
    expect(normalizeStructuredPhoneInput("  06 12 34 56 78  ")).toBe("+33612345678"); // leading/trailing whitespace trimmed
  });

  it("[international +...] normalized, separators stripped", () => {
    expect(normalizeStructuredPhoneInput("+33612345678")).toBe("+33612345678");
    expect(normalizeStructuredPhoneInput("+33 6 12 34 56 78")).toBe("+33612345678");
    expect(normalizeStructuredPhoneInput("+1 415 555 2671")).toBe("+14155552671");
  });

  it("[invalid format] rejected — null, never a guess", () => {
    expect(normalizeStructuredPhoneInput("12345")).toBeNull();
    expect(normalizeStructuredPhoneInput("abcdefghij")).toBeNull();
    expect(normalizeStructuredPhoneInput("")).toBeNull();
    expect(normalizeStructuredPhoneInput("0")).toBeNull();
  });

  it("[ambiguous format] never invents a country code for a shape that isn't the exact FR national or international pattern", () => {
    // 9 digits, no leading 0, no leading + — not a recognizable shape at all.
    expect(normalizeStructuredPhoneInput("123456789")).toBeNull();
    // A partial/truncated FR-looking number (9 digits after the 0) doesn't match the exact 10-digit FR shape.
    expect(normalizeStructuredPhoneInput("061234567")).toBeNull();
  });

  it("[digit-count bounds] an international-shaped value with too few/many significant digits is rejected, not truncated/padded", () => {
    expect(normalizeStructuredPhoneInput("+123456")).toBeNull(); // 6 digits, below the 8-digit floor
  });

  it("[whole-field anchoring] a phone-like substring embedded in extra text is rejected outright — this is a field validator, not a scanner", () => {
    expect(normalizeStructuredPhoneInput("mon numero est 0612345678")).toBeNull();
    expect(normalizeStructuredPhoneInput("0612345678 merci")).toBeNull();
  });
});
