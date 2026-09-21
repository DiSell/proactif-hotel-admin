import { describe, expect, it } from "vitest";
import { generateSmsReplyCode, hashSmsReplyCode, normalizeSmsReplyCode } from "./smsReplyCode";

const ALPHABET_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

describe("generateSmsReplyCode", () => {
  it("[length] always exactly 6 characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSmsReplyCode().code).toHaveLength(6);
    }
  });

  it("[alphabet] never contains ambiguous characters (0/O/1/I/L)", () => {
    for (let i = 0; i < 200; i++) {
      const { code } = generateSmsReplyCode();
      expect(code).toMatch(ALPHABET_PATTERN);
      expect(code).not.toMatch(/[01ILO]/);
    }
  });

  it("[uppercase] already normalized at generation", () => {
    const { code } = generateSmsReplyCode();
    expect(code).toBe(code.toUpperCase());
  });

  it("[randomness] two generated codes are (overwhelmingly likely to be) different", () => {
    const codes = new Set(Array.from({ length: 100 }, () => generateSmsReplyCode().code));
    expect(codes.size).toBeGreaterThan(90);
  });

  it("[hash] codeHash is the SHA-256 hex digest of the normalized code, never the raw code itself", () => {
    const { code, codeHash } = generateSmsReplyCode();
    expect(codeHash).toHaveLength(64);
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeHash).not.toBe(code);
    expect(codeHash).toBe(hashSmsReplyCode(code));
  });

  it("[never stores the raw code anywhere but the returned pair] the pair's only two fields are code/codeHash", () => {
    const pair = generateSmsReplyCode();
    expect(Object.keys(pair).sort()).toEqual(["code", "codeHash"]);
  });
});

describe("hashSmsReplyCode — deterministic, normalization-aware", () => {
  it("[same code, same hash] deterministic across calls", () => {
    expect(hashSmsReplyCode("K7M4PZ")).toBe(hashSmsReplyCode("K7M4PZ"));
  });

  it("[lowercase input] hashes identically to the uppercase form — a human-typed reply matches regardless of case", () => {
    expect(hashSmsReplyCode("k7m4pz")).toBe(hashSmsReplyCode("K7M4PZ"));
  });

  it("[surrounding whitespace] trimmed before hashing", () => {
    expect(hashSmsReplyCode("  K7M4PZ  ")).toBe(hashSmsReplyCode("K7M4PZ"));
  });

  it("[different codes] hash differently", () => {
    expect(hashSmsReplyCode("K7M4PZ")).not.toBe(hashSmsReplyCode("K7M4PY"));
  });
});

describe("normalizeSmsReplyCode", () => {
  it("[trims and uppercases]", () => {
    expect(normalizeSmsReplyCode("  k7m4pz  ")).toBe("K7M4PZ");
  });
});
