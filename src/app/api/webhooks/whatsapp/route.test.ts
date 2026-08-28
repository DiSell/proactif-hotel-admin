import { describe, expect, it, vi } from "vitest";
import { createWhatsAppWebhookHandlers, type WhatsAppWebhookDeps } from "./route";
import type { WebhookPostOutcome } from "@/lib/notifications/whatsapp/webhook";

function makeDeps(overrides: Partial<WhatsAppWebhookDeps> = {}): WhatsAppWebhookDeps {
  return {
    handleWebhookChallenge: vi.fn(() => null),
    handleWebhookPost: vi.fn<() => WebhookPostOutcome>(() => ({ ok: true, buttonTokens: [] })),
    resolvePartnerReplyToken: vi.fn(async () => null),
    applyPartnerReplyCommand: vi.fn(async () => undefined),
    ...overrides,
  };
}

function getRequest(url: string) {
  return new Request(url, { method: "GET" });
}

function postRequest(body: string, signature: string | null) {
  const headers = new Headers();
  if (signature) headers.set("x-hub-signature-256", signature);
  return new Request("https://example.com/api/webhooks/whatsapp", { method: "POST", body, headers });
}

describe("GET /api/webhooks/whatsapp — verification handshake", () => {
  it("[valid handshake] echoes the challenge with 200", async () => {
    const deps = makeDeps({ handleWebhookChallenge: vi.fn(() => "the-challenge") });
    const { GET } = createWhatsAppWebhookHandlers(deps);

    const response = await GET(getRequest("https://example.com/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=t&hub.challenge=the-challenge"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the-challenge");
  });

  it("[invalid handshake] returns 403, never echoes a challenge value", async () => {
    const deps = makeDeps({ handleWebhookChallenge: vi.fn(() => null) });
    const { GET } = createWhatsAppWebhookHandlers(deps);

    const response = await GET(getRequest("https://example.com/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x"));

    expect(response.status).toBe(403);
  });
});

describe("POST /api/webhooks/whatsapp — inbound button replies", () => {
  it("[invalid signature] returns 403, resolvePartnerReplyToken/applyPartnerReplyCommand never called", async () => {
    const resolvePartnerReplyToken = vi.fn(async () => null);
    const applyPartnerReplyCommand = vi.fn(async () => undefined);
    const deps = makeDeps({
      handleWebhookPost: vi.fn<() => WebhookPostOutcome>(() => ({ ok: false, reason: "invalid_signature", buttonTokens: [] })),
      resolvePartnerReplyToken,
      applyPartnerReplyCommand,
    });
    const { POST } = createWhatsAppWebhookHandlers(deps);

    const response = await POST(postRequest("{}", "sha256=bad"));

    expect(response.status).toBe(403);
    expect(resolvePartnerReplyToken).not.toHaveBeenCalled();
    expect(applyPartnerReplyCommand).not.toHaveBeenCalled();
  });

  it("[malformed payload] returns 403", async () => {
    const deps = makeDeps({ handleWebhookPost: vi.fn<() => WebhookPostOutcome>(() => ({ ok: false, reason: "malformed_payload", buttonTokens: [] })) });
    const { POST } = createWhatsAppWebhookHandlers(deps);

    const response = await POST(postRequest("not json", "sha256=x"));

    expect(response.status).toBe(403);
  });

  it("[valid, one resolvable token] resolves it and applies the exact decoded command with the decoded ids — never decoded from the token itself, only from resolvePartnerReplyToken's DB-backed result", async () => {
    const resolvePartnerReplyToken = vi.fn(async () => ({ deliveryId: "delivery-1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_accept" as const }));
    const applyPartnerReplyCommand = vi.fn(async () => undefined);
    const deps = makeDeps({
      handleWebhookPost: vi.fn<() => WebhookPostOutcome>(() => ({ ok: true, buttonTokens: ["opaque-token-abc"] })),
      resolvePartnerReplyToken,
      applyPartnerReplyCommand,
    });
    const { POST } = createWhatsAppWebhookHandlers(deps);

    const response = await POST(postRequest("{}", "sha256=good"));

    expect(response.status).toBe(200);
    expect(resolvePartnerReplyToken).toHaveBeenCalledWith("opaque-token-abc");
    expect(applyPartnerReplyCommand).toHaveBeenCalledTimes(1);
    expect(applyPartnerReplyCommand).toHaveBeenCalledWith("req-1", "hotel-1", "partner_accept", null);
  });

  it("[unresolvable token] resolvePartnerReplyToken returns null -> applyPartnerReplyCommand never called for it, request still succeeds", async () => {
    const resolvePartnerReplyToken = vi.fn(async () => null);
    const applyPartnerReplyCommand = vi.fn(async () => undefined);
    const deps = makeDeps({
      handleWebhookPost: vi.fn<() => WebhookPostOutcome>(() => ({ ok: true, buttonTokens: ["unknown-or-foreign-token"] })),
      resolvePartnerReplyToken,
      applyPartnerReplyCommand,
    });
    const { POST } = createWhatsAppWebhookHandlers(deps);

    const response = await POST(postRequest("{}", "sha256=good"));

    expect(response.status).toBe(200);
    expect(applyPartnerReplyCommand).not.toHaveBeenCalled();
  });

  it("[raw body passed through unparsed] the exact request body text reaches handleWebhookPost, not a re-serialized object", async () => {
    const handleWebhookPost = vi.fn<() => WebhookPostOutcome>(() => ({ ok: true, buttonTokens: [] }));
    const deps = makeDeps({ handleWebhookPost });
    const { POST } = createWhatsAppWebhookHandlers(deps);
    const rawBody = '{"entry":[{"changes":[]}]}';

    await POST(postRequest(rawBody, "sha256=good"));

    expect(handleWebhookPost).toHaveBeenCalledWith(rawBody, "sha256=good");
  });

  it("[one bad reply never fails the whole request] applyPartnerReplyCommand throwing for one token still returns 200, other tokens still processed", async () => {
    const resolvePartnerReplyToken = vi
      .fn()
      .mockResolvedValueOnce({ deliveryId: "d1", hotelId: "hotel-1", partnerRequestId: "req-1", command: "partner_accept" })
      .mockResolvedValueOnce({ deliveryId: "d2", hotelId: "hotel-1", partnerRequestId: "req-2", command: "partner_reject" });
    const applyPartnerReplyCommand = vi.fn().mockRejectedValueOnce(new Error("not allowed from status accepted")).mockResolvedValueOnce(undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps({
      handleWebhookPost: vi.fn<() => WebhookPostOutcome>(() => ({ ok: true, buttonTokens: ["token-1", "token-2"] })),
      resolvePartnerReplyToken,
      applyPartnerReplyCommand,
    });
    const { POST } = createWhatsAppWebhookHandlers(deps);

    const response = await POST(postRequest("{}", "sha256=good"));

    expect(response.status).toBe(200);
    expect(applyPartnerReplyCommand).toHaveBeenCalledTimes(2);
    consoleErrorSpy.mockRestore();
  });

  it("[route never reads hotelId/partnerRequestId from the raw body or query params itself] it only ever forwards whatever resolvePartnerReplyToken decoded from the database", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "route.ts"), "utf8");
    expect(source).not.toMatch(/searchParams\.get\("hotelId"\)|searchParams\.get\("partnerRequestId"\)|json\.hotelId|json\.partnerRequestId/);
    // No JSON.parse/base64 decoding of the button token itself anywhere in
    // the route's executable code — only resolvePartnerReplyToken(token) is
    // ever called on it (the doc comment above legitimately names "decode"
    // in prose to describe what must NEVER happen).
    expect(source).not.toMatch(/JSON\.parse\([^)]*token/i);
    expect(source).not.toMatch(/Buffer\.from\([^)]*token/i);
  });
});
