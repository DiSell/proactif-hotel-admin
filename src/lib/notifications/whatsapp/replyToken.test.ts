import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { generatePartnerReplyToken, generatePartnerReplyTokenSet, hashPartnerReplyToken } from "./replyToken";

describe("generatePartnerReplyToken", () => {
  it("[shape] returns a token and its SHA-256 hash", () => {
    const { token, tokenHash } = generatePartnerReplyToken();
    expect(typeof token).toBe("string");
    expect(tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
  });

  it("[256 bits of randomness] the raw token is 32 bytes hex-encoded (64 hex chars)", () => {
    const { token } = generatePartnerReplyToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[never identical across calls] two generated tokens are always different", () => {
    const a = generatePartnerReplyToken();
    const b = generatePartnerReplyToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it("[carries zero decodable information] the token is plain random hex — no JSON, no base64url-encoded structure, nothing to parse out of it", () => {
    const { token } = generatePartnerReplyToken();
    expect(() => JSON.parse(Buffer.from(token, "hex").toString("utf8"))).toThrow();
    expect(token).not.toMatch(/[{}[\]":]/); // no JSON-shaped characters at all — plain hex only
  });
});

describe("hashPartnerReplyToken", () => {
  it("[deterministic] the same token always hashes to the same value", () => {
    const { token, tokenHash } = generatePartnerReplyToken();
    expect(hashPartnerReplyToken(token)).toBe(tokenHash);
  });

  it("[matches Node's own sha256] cross-checked against node:crypto directly", () => {
    expect(hashPartnerReplyToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});

describe("generatePartnerReplyTokenSet", () => {
  it("[three independent tokens] accept/reject/alternative are never identical to one another", () => {
    const set = generatePartnerReplyTokenSet();
    expect(set.accept.token).not.toBe(set.reject.token);
    expect(set.accept.token).not.toBe(set.alternative.token);
    expect(set.reject.token).not.toBe(set.alternative.token);
  });

  it("[hashes match their own tokens]", () => {
    const set = generatePartnerReplyTokenSet();
    expect(set.accept.tokenHash).toBe(hashPartnerReplyToken(set.accept.token));
    expect(set.reject.tokenHash).toBe(hashPartnerReplyToken(set.reject.token));
    expect(set.alternative.tokenHash).toBe(hashPartnerReplyToken(set.alternative.token));
  });

  it("[no partnerRequestId/hotelId/command anywhere in the CODE] the old HMAC/JSON design is fully removed — doc comments may mention it in prose to explain the change", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "replyToken.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/partnerRequestId|hotelId|createHmac|base64url/);
  });
});
