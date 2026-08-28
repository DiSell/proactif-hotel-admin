import { describe, expect, it, vi } from "vitest";
import { handleWebhookChallenge, handleWebhookPost } from "./webhook";
import type { WhatsAppProvider, WhatsAppWebhookParseResult } from "./types";

function fakeProvider(overrides: Partial<WhatsAppProvider> = {}): WhatsAppProvider {
  return {
    sendTemplateMessage: vi.fn(),
    verifyWebhookChallenge: vi.fn(() => "the-challenge"),
    parseWebhookPayload: vi.fn<() => WhatsAppWebhookParseResult>(() => ({ ok: true, events: [] })),
    ...overrides,
  };
}

describe("handleWebhookChallenge", () => {
  it("[delegates to the injected provider]", () => {
    const provider = fakeProvider({ verifyWebhookChallenge: vi.fn(() => "echoed") });

    const result = handleWebhookChallenge({ mode: "subscribe", token: "t", challenge: "c" }, { provider });

    expect(result).toBe("echoed");
    expect(provider.verifyWebhookChallenge).toHaveBeenCalledWith({ mode: "subscribe", token: "t", challenge: "c" });
  });

  it("[provider rejects] returns null", () => {
    const provider = fakeProvider({ verifyWebhookChallenge: vi.fn(() => null) });

    expect(handleWebhookChallenge({ mode: "subscribe", token: "wrong", challenge: "c" }, { provider })).toBeNull();
  });
});

describe("handleWebhookPost — DB-free, decode-free (reply tokens are opaque, see replyToken.ts)", () => {
  it("[provider rejects the signature] returns ok:false with the provider's own reason, empty buttonTokens", () => {
    const provider = fakeProvider({ parseWebhookPayload: vi.fn<() => WhatsAppWebhookParseResult>(() => ({ ok: false, error: "invalid_signature" })) });

    const outcome = handleWebhookPost("{}", "sha256=bad", { provider });

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature", buttonTokens: [] });
  });

  it("[malformed payload] returns ok:false, reason malformed_payload", () => {
    const provider = fakeProvider({ parseWebhookPayload: vi.fn<() => WhatsAppWebhookParseResult>(() => ({ ok: false, error: "malformed_payload" })) });

    const outcome = handleWebhookPost("not json", null, { provider });

    expect(outcome).toEqual({ ok: false, reason: "malformed_payload", buttonTokens: [] });
  });

  it("[button reply] extracts the RAW opaque token verbatim — never decoded, never inspected", () => {
    const provider = fakeProvider({
      parseWebhookPayload: vi.fn<() => WhatsAppWebhookParseResult>(() => ({
        ok: true,
        events: [{ type: "button_reply", payload: "opaque-token-abc123", fromE164: "+33612345678" }],
      })),
    });

    const outcome = handleWebhookPost("{}", "sha256=whatever", { provider });

    expect(outcome).toEqual({ ok: true, buttonTokens: ["opaque-token-abc123"] });
  });

  it("[unhandled event] never turned into a button token", () => {
    const provider = fakeProvider({ parseWebhookPayload: vi.fn<() => WhatsAppWebhookParseResult>(() => ({ ok: true, events: [{ type: "unhandled" }] })) });

    const outcome = handleWebhookPost("{}", "sha256=whatever", { provider });

    expect(outcome).toEqual({ ok: true, buttonTokens: [] });
  });

  it("[multiple events] only button_reply payloads survive, in order, unhandled events skipped", () => {
    const provider = fakeProvider({
      parseWebhookPayload: vi.fn<() => WhatsAppWebhookParseResult>(() => ({
        ok: true,
        events: [
          { type: "unhandled" },
          { type: "button_reply", payload: "token-a", fromE164: "+1" },
          { type: "unhandled" },
          { type: "button_reply", payload: "token-b", fromE164: "+2" },
        ],
      })),
    });

    const outcome = handleWebhookPost("{}", "sha256=whatever", { provider });

    expect(outcome.buttonTokens).toEqual(["token-a", "token-b"]);
  });

  it("[no DB access, no decoding] this module never IMPORTS deliveryService or replyToken's hash function — resolving a token is a database lookup owned elsewhere (doc comments may name it in prose)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "webhook.ts"), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => line.trim().startsWith("import"))
      .join("\n");
    expect(importLines).not.toMatch(/deliveryService|hashPartnerReplyToken|createAdminClient/);
  });
});
