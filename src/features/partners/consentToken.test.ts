import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generateConsentToken, hashConsentToken } from "./consentToken";

describe("generateConsentToken", () => {
  it("returns a 256-bit hex token paired with its SHA-256 hash", () => {
    const { token, tokenHash } = generateConsentToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("never returns the same token twice", () => {
    const a = generateConsentToken();
    const b = generateConsentToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe("hashConsentToken", () => {
  it("is deterministic", () => {
    const { token } = generateConsentToken();
    expect(hashConsentToken(token)).toBe(hashConsentToken(token));
  });

  it("matches a manually computed SHA-256 digest", () => {
    expect(hashConsentToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});
