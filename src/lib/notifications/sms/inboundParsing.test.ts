import { describe, expect, it } from "vitest";
import { parseInboundSmsBody } from "./inboundParsing";

describe("parseInboundSmsBody — deterministic, no LLM involved", () => {
  it("[1 CODE] accept, no free text", () => {
    expect(parseInboundSmsBody("1 K7M4PZ")).toEqual({ digit: "1", code: "K7M4PZ", freeText: null });
  });

  it("[2 CODE] reject, no free text", () => {
    expect(parseInboundSmsBody("2 K7M4PZ")).toEqual({ digit: "2", code: "K7M4PZ", freeText: null });
  });

  it("[3 CODE 21h00] alternative with free text", () => {
    expect(parseInboundSmsBody("3 K7M4PZ 21h00")).toEqual({ digit: "3", code: "K7M4PZ", freeText: "21h00" });
  });

  it("[3 CODE, free text with spaces/punctuation] the entire remainder is captured verbatim (trimmed)", () => {
    expect(parseInboundSmsBody("3 K7M4PZ Terrasse indisponible, intérieur possible")).toEqual({
      digit: "3",
      code: "K7M4PZ",
      freeText: "Terrasse indisponible, intérieur possible",
    });
  });

  it("[3 CODE with no text at all] freeText is null — caller must reject this cleanly, never crash on it", () => {
    expect(parseInboundSmsBody("3 K7M4PZ")).toEqual({ digit: "3", code: "K7M4PZ", freeText: null });
  });

  it("[3 CODE with only whitespace after] treated the same as no text", () => {
    expect(parseInboundSmsBody("3 K7M4PZ    ")).toEqual({ digit: "3", code: "K7M4PZ", freeText: null });
  });

  it("[lowercase code] normalized to uppercase", () => {
    expect(parseInboundSmsBody("1 k7m4pz")).toEqual({ digit: "1", code: "K7M4PZ", freeText: null });
  });

  it("[leading/trailing whitespace on the whole body] trimmed before parsing", () => {
    expect(parseInboundSmsBody("  1 K7M4PZ  ")).toEqual({ digit: "1", code: "K7M4PZ", freeText: null });
  });

  it("[invalid digit, e.g. 4] rejected — null", () => {
    expect(parseInboundSmsBody("4 K7M4PZ")).toBeNull();
  });

  it("[invalid digit, e.g. 0] rejected — null", () => {
    expect(parseInboundSmsBody("0 K7M4PZ")).toBeNull();
  });

  it("[no code at all] rejected — null", () => {
    expect(parseInboundSmsBody("1")).toBeNull();
  });

  it("[completely unrelated free text] rejected — null, never guessed at", () => {
    expect(parseInboundSmsBody("Bonjour, je confirme la reservation")).toBeNull();
  });

  it("[empty body] rejected — null", () => {
    expect(parseInboundSmsBody("")).toBeNull();
    expect(parseInboundSmsBody("   ")).toBeNull();
  });

  it("[digit with no separating space before the code] rejected — null, never guessed at a boundary", () => {
    expect(parseInboundSmsBody("1K7M4PZ")).toBeNull();
  });
});
