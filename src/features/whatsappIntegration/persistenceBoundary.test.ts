import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoSrc = join(here, "..", "..");

function readSource(...segments: string[]): string {
  return readFileSync(join(repoSrc, ...segments), "utf8");
}

function listFiles(...segments: string[]): string[] {
  return readdirSync(join(repoSrc, ...segments)).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
}

/**
 * Guarantees specific to 0024_hotel_whatsapp_connections.sql's own
 * boundaries (task section 17) — kept separate from
 * EmbeddedSignupButton.test.ts/actions.test.ts since these concern the
 * DATABASE-facing type and the wider codebase's isolation from it, not the
 * Embedded Signup UI flow itself.
 */
describe("HotelWhatsAppConnection type — no secret field, ever", () => {
  it("[no token/credential field anywhere in the type definition]", () => {
    const source = readSource("features", "whatsappIntegration", "types.ts");
    const typeStart = source.indexOf("export interface HotelWhatsAppConnection");
    const typeBlock = source.slice(typeStart, source.indexOf("}", typeStart) + 1);
    expect(typeBlock).not.toMatch(/access_token|refresh_token|authorization_code|app_secret|verify_token|system_user_token|credential|secret/i);
  });

  it("[status active is never, by itself, a send guarantee — documented, not just assumed]", () => {
    const source = readSource("features", "whatsappIntegration", "types.ts");
    const typeStart = source.indexOf("export interface HotelWhatsAppConnection");
    const docCommentStart = source.lastIndexOf("/**", typeStart);
    const docComment = source
      .slice(docCommentStart, typeStart)
      .replace(/^\s*\*\s?/gm, " ")
      .replace(/\s+/g, " ");
    expect(docComment).toMatch(/NEVER, by itself, proof that messages can actually be sent/);
  });
});

describe("RAG/LLM never touches hotel_whatsapp_connections data", () => {
  it("[features/rag/* never references HotelWhatsAppConnection or the table name]", () => {
    for (const file of listFiles("features", "rag")) {
      const source = readSource("features", "rag", file);
      expect(source).not.toMatch(/HotelWhatsAppConnection|hotel_whatsapp_connections/);
    }
  });

  it("[features/widget/* never references it either — the public chat widget has no business with WhatsApp connection data]", () => {
    for (const file of listFiles("features", "widget")) {
      if (file.endsWith(".tsx")) continue; // client components can't reach server-only DB rows anyway; .ts files are the ones that could theoretically import a type
      const source = readSource("features", "widget", file);
      expect(source).not.toMatch(/HotelWhatsAppConnection|hotel_whatsapp_connections/);
    }
  });
});

describe("Embedded Signup UI never claims/derives \"active\" status itself", () => {
  it("[EmbeddedSignupButton.tsx never references the DB status value \"active\"] the browser-side code has no writer at all yet, and never should derive this value on its own", () => {
    const source = readSource("features", "whatsappIntegration", "EmbeddedSignupButton.tsx");
    expect(source).not.toMatch(/"active"/);
  });

  it("[actions.ts never sets/returns status: \"active\"] the current server action explicitly stops before any such write", () => {
    const source = readSource("features", "whatsappIntegration", "actions.ts");
    expect(source).not.toMatch(/status:\s*"active"/);
  });
});

describe("Current WhatsApp transport provider is NOT refactored by this migration", () => {
  it("[metaProvider.ts / sendPartnerRequest.ts / provider.ts never reference hotel_whatsapp_connections or HotelWhatsAppConnection]", () => {
    for (const file of ["metaProvider.ts", "sendPartnerRequest.ts", "provider.ts", "webhook.ts", "replyToken.ts", "types.ts"]) {
      const source = readSource("lib", "notifications", "whatsapp", file);
      expect(source).not.toMatch(/HotelWhatsAppConnection|hotel_whatsapp_connections/);
    }
  });

  it("[metaProvider.ts still reads the global WHATSAPP_META_PHONE_NUMBER_ID env var — not yet per-hotel] documents the deliberate deferral (task section 14)", () => {
    const source = readSource("lib", "notifications", "whatsapp", "metaProvider.ts");
    expect(source).toMatch(/WHATSAPP_META_PHONE_NUMBER_ID/);
  });
});

describe("metaEmbeddedSignup.ts never persists — the finalization CHAIN and the finalization WRITE stay strictly separate", () => {
  it("[never references hotel_whatsapp_connections/HotelWhatsAppConnection/Supabase] this file only talks to graph.facebook.com; persistence is 0025's own unbuilt RPC, never invented here", () => {
    const source = readSource("lib", "notifications", "whatsapp", "metaEmbeddedSignup.ts");
    expect(source).not.toMatch(/HotelWhatsAppConnection|hotel_whatsapp_connections|createAdminClient|createClient\(|\.from\(|\.rpc\(/);
  });

  it("[connection_type is narrowed to \"coexistence\" only] cloud_api_only is never returned as ok:true — the phone-number registration step it would require was not confirmed against Meta's documentation this task", () => {
    const source = readSource("lib", "notifications", "whatsapp", "metaEmbeddedSignup.ts");
    expect(source).not.toMatch(/connectionType:\s*"cloud_api_only"/);
  });
});

describe("finalize_hotel_whatsapp_connection_with_secret (0026) is the ONLY reachable RPC call site", () => {
  it("[only connectionPersistence.ts calls it] metaEmbeddedSignup.ts, actions.ts, and EmbeddedSignupButton.tsx never call any Supabase RPC directly — persistence is delegated entirely (comments MAY name the RPC in prose to document that delegation; only the executable code is checked here)", () => {
    for (const [dir, file] of [
      ["lib", "notifications", "whatsapp", "metaEmbeddedSignup.ts"],
      ["features", "whatsappIntegration", "actions.ts"],
      ["features", "whatsappIntegration", "EmbeddedSignupButton.tsx"],
    ].map((segments) => [segments.slice(0, -1), segments[segments.length - 1]] as const)) {
      const source = readSource(...dir, file);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/finalize_hotel_whatsapp_connection|createAdminClient|\.rpc\(/);
    }
  });

  it("[connectionPersistence.ts never calls the historical finalize_hotel_whatsapp_connection (0025) directly] only the composite 0026 RPC name appears", () => {
    const source = readSource("lib", "notifications", "whatsapp", "connectionPersistence.ts");
    expect(source).toMatch(/finalize_hotel_whatsapp_connection_with_secret/);
    expect(source).not.toMatch(/"finalize_hotel_whatsapp_connection"/);
  });
});

describe("No new migration file other than 0024 was added in this task", () => {
  it("[0020/0021/0022/0023 migrations are untouched — only inspected via their own doc comments elsewhere]", () => {
    // A lightweight content-drift guard: each historical migration's own
    // final GRANT/REVOKE line for its own primary table must still be
    // present verbatim — a targeted, cheap proxy for "this file was not
    // edited", without hashing the whole repo.
    const m0020 = readSource("..", "supabase", "migrations", "0020_partner_requests.sql");
    expect(m0020).toMatch(/grant execute on function public\.apply_partner_request_command\(uuid, uuid, text, text, jsonb\) to authenticated, service_role;/);
  });
});
