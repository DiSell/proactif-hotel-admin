import { afterEach, describe, expect, it } from "vitest";
import { generateUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribeToken";

afterEach(() => {
  delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
});

describe("generateUnsubscribeToken / verifyUnsubscribeToken", () => {
  it("[round trip] a generated token verifies back to the same customer id", () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    const token = generateUnsubscribeToken("customer-1");
    expect(token).toBeTruthy();
    expect(verifyUnsubscribeToken(token!)).toBe("customer-1");
  });

  it("[no secret configured] generation returns null — fail closed, never an unsigned/weak token", () => {
    delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
    expect(generateUnsubscribeToken("customer-1")).toBeNull();
  });

  it("[verification without a secret configured] returns null, never accepts blindly", () => {
    delete process.env.LOYALTY_UNSUBSCRIBE_SECRET;
    expect(verifyUnsubscribeToken("customer-1.deadbeef")).toBeNull();
  });

  it("[tampered customer id] a token re-targeted at a different customer id fails verification", () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    const token = generateUnsubscribeToken("customer-1")!;
    const [, signature] = [token.slice(0, token.lastIndexOf(".")), token.slice(token.lastIndexOf(".") + 1)];
    expect(verifyUnsubscribeToken(`customer-2.${signature}`)).toBeNull();
  });

  it("[tampered signature] a forged signature fails verification", () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    expect(verifyUnsubscribeToken("customer-1.0000000000000000000000000000000000000000000000000000000000000000")).toBeNull();
  });

  it("[wrong secret] a token generated under a different secret is rejected", () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    const token = generateUnsubscribeToken("customer-1")!;
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-b";
    expect(verifyUnsubscribeToken(token)).toBeNull();
  });

  it("[malformed token] no separator, or garbage input, never throws", () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    expect(verifyUnsubscribeToken("not-a-real-token")).toBeNull();
    expect(verifyUnsubscribeToken("")).toBeNull();
    expect(verifyUnsubscribeToken("...")).toBeNull();
  });

  it("[never returns the raw secret or persists anything] purely stateless", () => {
    process.env.LOYALTY_UNSUBSCRIBE_SECRET = "secret-a";
    const token = generateUnsubscribeToken("customer-1")!;
    expect(token).not.toContain("secret-a");
  });
});
