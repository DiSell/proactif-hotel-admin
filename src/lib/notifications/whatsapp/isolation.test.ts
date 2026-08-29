import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, "..", "..", "..");

function readSource(...segments: string[]): string {
  return readFileSync(join(repoSrc, ...segments), "utf8");
}

function listTsFiles(...segments: string[]): string[] {
  const dir = join(repoSrc, ...segments);
  return readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
}

/**
 * Structural (compile-error-if-violated, not just convention) guarantees
 * that the WhatsApp transport layer never leaks toward the chatbot/RAG
 * pipeline or the public widget — task section 15's "request_phone_e164 ne
 * doit jamais arriver dans RAG / prompt / LLM / widget public" requirement,
 * extended to this new module.
 */
describe("WhatsApp transport layer — never reachable from RAG/widget/LLM", () => {
  it("[features/rag/* never imports lib/notifications/whatsapp]", () => {
    for (const file of listTsFiles("features", "rag")) {
      if (file.endsWith(".test.ts")) continue;
      const source = readSource("features", "rag", file);
      expect(source).not.toMatch(/notifications\/whatsapp/);
    }
  });

  it("[features/widget/* never imports lib/notifications/whatsapp]", () => {
    for (const file of listTsFiles("features", "widget")) {
      if (file.endsWith(".test.ts") || file.endsWith(".tsx")) continue;
      const source = readSource("features", "widget", file);
      expect(source).not.toMatch(/notifications\/whatsapp/);
    }
  });

  it("[no NEXT_PUBLIC_ WhatsApp variable ever READ] doc comments may mention the prefix in prose (to explain its absence) — only an actual process.env.NEXT_PUBLIC_* read is disallowed", () => {
    for (const file of ["types.ts", "provider.ts", "metaProvider.ts", "replyToken.ts", "sendPartnerRequest.ts", "webhook.ts", "connectionSecretCrypto.ts"]) {
      const source = readSource("lib", "notifications", "whatsapp", file);
      expect(source).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
    }
  });

  it("[.env.example documents transport-layer WhatsApp vars without NEXT_PUBLIC_ prefix or a real value]", () => {
    const envExample = readFileSync(join(repoSrc, "..", ".env.example"), "utf8");
    // Scoped to this transport layer's own send/webhook vars specifically
    // (the literal `WHATSAPP_` prefix) — deliberately does NOT match
    // NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID, a SEPARATE, intentionally
    // public Meta Embedded Signup identifier
    // (features/whatsappIntegration/, own test coverage there) that also
    // happens to contain the word "WHATSAPP".
    const whatsappLines = envExample.split("\n").filter((line) => /^#?\s*WHATSAPP_/.test(line.trim()));
    expect(whatsappLines.length).toBeGreaterThan(0);
    for (const line of whatsappLines) {
      expect(line).not.toMatch(/NEXT_PUBLIC_/);
      // Every WHATSAPP_ variable line is either commented out (# ...=) or a
      // bare "KEY=meta" placeholder documented in a comment — never a real
      // access token/secret value committed.
      expect(line).not.toMatch(/WHATSAPP_META_ACCESS_TOKEN=.+\S/);
      expect(line).not.toMatch(/WHATSAPP_META_APP_SECRET=.+\S/);
      expect(line).not.toMatch(/WHATSAPP_META_VERIFY_TOKEN=.+\S/);
      // Same discipline for the connectionSecretCrypto.ts AES key
      // variables — never a real base64 key or key id committed.
      expect(line).not.toMatch(/WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64=.+\S/);
      expect(line).not.toMatch(/WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_ID=.+\S/);
      expect(line).not.toMatch(/WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_B64=.+\S/);
      expect(line).not.toMatch(/WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_ID=.+\S/);
    }
  });
});
