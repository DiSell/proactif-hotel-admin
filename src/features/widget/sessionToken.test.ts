import { describe, expect, it } from "vitest";
import { hashSessionToken, sessionTokensMatch, SESSION_TOKEN_PATTERN } from "./sessionToken";

const VALID_TOKEN_A = "a".repeat(64);
const VALID_TOKEN_B = "b".repeat(64);

describe("hashSessionToken", () => {
  it("is deterministic — the same raw token always hashes to the same value", () => {
    expect(hashSessionToken(VALID_TOKEN_A)).toBe(hashSessionToken(VALID_TOKEN_A));
  });

  it("different tokens hash to different values", () => {
    expect(hashSessionToken(VALID_TOKEN_A)).not.toBe(hashSessionToken(VALID_TOKEN_B));
  });

  it("produces a 64-char lowercase hex digest (SHA-256)", () => {
    expect(hashSessionToken(VALID_TOKEN_A)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sessionTokensMatch", () => {
  it("[good token] the correct hash matches itself", () => {
    const hash = hashSessionToken(VALID_TOKEN_A);
    expect(sessionTokensMatch(hash, hash)).toBe(true);
  });

  it("[wrong token] a different token's hash does not match", () => {
    const stored = hashSessionToken(VALID_TOKEN_A);
    const provided = hashSessionToken(VALID_TOKEN_B);
    expect(sessionTokensMatch(stored, provided)).toBe(false);
  });

  it("[no stored hash] null/undefined stored hash never matches, regardless of what's provided", () => {
    const provided = hashSessionToken(VALID_TOKEN_A);
    expect(sessionTokensMatch(null, provided)).toBe(false);
    expect(sessionTokensMatch(undefined, provided)).toBe(false);
  });

  it("[length mismatch] never throws, just returns false — including on garbage input that isn't even a valid hash shape", () => {
    expect(sessionTokensMatch("short", "alsoshort")).toBe(false);
    expect(() => sessionTokensMatch("short", hashSessionToken(VALID_TOKEN_A))).not.toThrow();
    expect(sessionTokensMatch("short", hashSessionToken(VALID_TOKEN_A))).toBe(false);
  });

  it("[almost-right] a hash that differs by a single trailing character does not match", () => {
    const hash = hashSessionToken(VALID_TOKEN_A);
    const almost = hash.slice(0, -1) + (hash.endsWith("0") ? "1" : "0");
    expect(sessionTokensMatch(hash, almost)).toBe(false);
  });
});

describe("SESSION_TOKEN_PATTERN", () => {
  it("accepts exactly 64 lowercase hex characters (256 bits)", () => {
    expect(SESSION_TOKEN_PATTERN.test(VALID_TOKEN_A)).toBe(true);
    expect(SESSION_TOKEN_PATTERN.test("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("rejects too short, too long, uppercase, or non-hex", () => {
    expect(SESSION_TOKEN_PATTERN.test("a".repeat(32))).toBe(false);
    expect(SESSION_TOKEN_PATTERN.test("a".repeat(128))).toBe(false);
    expect(SESSION_TOKEN_PATTERN.test("A".repeat(64))).toBe(false);
    expect(SESSION_TOKEN_PATTERN.test("g".repeat(64))).toBe(false);
    expect(SESSION_TOKEN_PATTERN.test("")).toBe(false);
  });
});
