import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generateActivationToken, hashActivationToken } from "./activationToken";

describe("generateActivationToken", () => {
  it("returns a 256-bit hex token paired with its SHA-256 hash", () => {
    const { token, tokenHash } = generateActivationToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("never returns the same token twice", () => {
    const a = generateActivationToken();
    const b = generateActivationToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe("hashActivationToken", () => {
  it("is deterministic", () => {
    const { token } = generateActivationToken();
    expect(hashActivationToken(token)).toBe(hashActivationToken(token));
  });

  it("matches a manually computed SHA-256 digest", () => {
    expect(hashActivationToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});
