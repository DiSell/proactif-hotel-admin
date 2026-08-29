import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { handleWebhookChallenge, handleWebhookPost } from "./webhook";

describe("handleWebhookChallenge — requires ONLY the verify-token config", () => {
  it("[valid handshake] returns the challenge string", () => {
    const result = handleWebhookChallenge(
      { mode: "subscribe", token: "correct-token", challenge: "the-challenge" },
      { verifyConfig: { verifyToken: "correct-token" } }
    );

    expect(result).toBe("the-challenge");
  });

  it("[wrong token] returns null", () => {
    const result = handleWebhookChallenge(
      { mode: "subscribe", token: "wrong-token", challenge: "the-challenge" },
      { verifyConfig: { verifyToken: "correct-token" } }
    );

    expect(result).toBeNull();
  });

  it("[verifyConfig explicitly null — not configured] returns null regardless of the token supplied", () => {
    const result = handleWebhookChallenge({ mode: "subscribe", token: "anything", challenge: "c" }, { verifyConfig: null });

    expect(result).toBeNull();
  });

  it("[missing mode/challenge] returns null even with the correct token", () => {
    expect(handleWebhookChallenge({ mode: null, token: "correct-token", challenge: "c" }, { verifyConfig: { verifyToken: "correct-token" } })).toBeNull();
    expect(handleWebhookChallenge({ mode: "subscribe", token: "correct-token", challenge: null }, { verifyConfig: { verifyToken: "correct-token" } })).toBeNull();
  });

  it("[no signatureConfig required] a valid challenge succeeds with no signatureConfig passed at all — GET and POST configuration are fully independent", () => {
    const result = handleWebhookChallenge({ mode: "subscribe", token: "t", challenge: "c" }, { verifyConfig: { verifyToken: "t" } });

    expect(result).toBe("c");
  });
});

describe("handleWebhookPost — requires ONLY the signature config, decode-free (reply tokens are opaque, see replyToken.ts)", () => {
  const appSecret = "webhook-secret";

  function sign(rawBody: string): string {
    return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  }

  it("[signatureConfig explicitly null — not configured] rejected as invalid_signature regardless of the header supplied", () => {
    const outcome = handleWebhookPost("{}", "sha256=whatever", { signatureConfig: null });

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature", buttonTokens: [] });
  });

  it("[missing signature header] rejected as invalid_signature", () => {
    const outcome = handleWebhookPost("{}", null, { signatureConfig: { appSecret } });

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature", buttonTokens: [] });
  });

  it("[wrong signature] rejected as invalid_signature — APP_SECRET is never bypassed", () => {
    const outcome = handleWebhookPost("{}", "sha256=deadbeef", { signatureConfig: { appSecret } });

    expect(outcome).toEqual({ ok: false, reason: "invalid_signature", buttonTokens: [] });
  });

  it("[malformed payload, valid signature] returns ok:false, reason malformed_payload", () => {
    const rawBody = "{not valid json";
    const outcome = handleWebhookPost(rawBody, sign(rawBody), { signatureConfig: { appSecret } });

    expect(outcome).toEqual({ ok: false, reason: "malformed_payload", buttonTokens: [] });
  });

  it("[button reply, valid signature] extracts the RAW opaque token verbatim — never decoded, never inspected", () => {
    const rawBody = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "33612345678", button: { payload: "opaque-token-abc123" } }] } }] }],
    });

    const outcome = handleWebhookPost(rawBody, sign(rawBody), { signatureConfig: { appSecret } });

    expect(outcome).toEqual({ ok: true, buttonTokens: ["opaque-token-abc123"] });
  });

  it("[unhandled event] never turned into a button token", () => {
    const rawBody = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "33612345678", text: { body: "oui je confirme" } }] } }] }],
    });

    const outcome = handleWebhookPost(rawBody, sign(rawBody), { signatureConfig: { appSecret } });

    expect(outcome).toEqual({ ok: true, buttonTokens: [] });
  });

  it("[multiple events] only button_reply payloads survive, in order, unhandled events skipped", () => {
    const rawBody = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { from: "1", text: { body: "hi" } },
                  { from: "1", button: { payload: "token-a" } },
                  { from: "2", text: { body: "hi" } },
                  { from: "2", button: { payload: "token-b" } },
                ],
              },
            },
          ],
        },
      ],
    });

    const outcome = handleWebhookPost(rawBody, sign(rawBody), { signatureConfig: { appSecret } });

    expect(outcome.buttonTokens).toEqual(["token-a", "token-b"]);
  });

  it("[no verifyConfig required] a valid POST succeeds with no verifyConfig passed at all — GET and POST configuration are fully independent", () => {
    const rawBody = JSON.stringify({ entry: [] });
    const outcome = handleWebhookPost(rawBody, sign(rawBody), { signatureConfig: { appSecret } });

    expect(outcome.ok).toBe(true);
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

  it("[never routes through getWhatsAppProvider/the full send config] webhook.ts never IMPORTS provider.ts — GET/POST verification are structurally decoupled from ACCESS_TOKEN/PHONE_NUMBER_ID/API_VERSION/template (doc comments may name it in prose to explain the decoupling)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "webhook.ts"), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => line.trim().startsWith("import"))
      .join("\n");
    expect(importLines).not.toMatch(/from "\.\/provider"/);
    expect(importLines).not.toMatch(/getWhatsAppProvider/);
  });
});
