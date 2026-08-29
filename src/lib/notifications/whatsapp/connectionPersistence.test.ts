import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toPostgresByteaHex } from "./connectionPersistence";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "connectionPersistence.ts"), "utf8");

/** Same mocking pattern as features/partners/consentActions.test.ts — the only place createAdminClient() is faked in this repo. */
function fakeAdminClient(rpcResult: { data: unknown; error: { code?: string } | null }) {
  const rpc = vi.fn(async () => rpcResult);
  return { rpc };
}

const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

afterEach(() => {
  mockCreateAdminClient.mockReset();
  vi.restoreAllMocks();
});

const INPUT = {
  hotelId: "11111111-1111-1111-1111-111111111111",
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  businessId: "biz-1",
  connectionType: "coexistence" as const,
  ciphertext: Buffer.from([0xaa, 0xbb, 0xcc]),
  nonce: Buffer.from(Array(12).fill(1)),
  authTag: Buffer.from(Array(16).fill(2)),
  keyId: "v1",
  encryptionVersion: 1,
};

describe("toPostgresByteaHex", () => {
  it("produces the standard `\\x` + hex PostgreSQL bytea literal format", () => {
    expect(toPostgresByteaHex(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe("\\xdeadbeef");
  });

  it("handles an empty buffer", () => {
    expect(toPostgresByteaHex(Buffer.alloc(0))).toBe("\\x");
  });
});

describe("persistWhatsAppConnection", () => {
  it("[correct RPC name] calls finalize_hotel_whatsapp_connection_with_secret, never the historical 0025 RPC directly", async () => {
    const client = fakeAdminClient({
      data: [{ id: "conn-1", connection_type: "coexistence", connected_at: "2026-01-01T00:00:00Z" }],
      error: null,
    });
    mockCreateAdminClient.mockReturnValue(client);
    const { persistWhatsAppConnection } = await import("./connectionPersistence");

    await persistWhatsAppConnection(INPUT);

    expect(client.rpc).toHaveBeenCalledWith("finalize_hotel_whatsapp_connection_with_secret", expect.any(Object));
    expect(client.rpc).not.toHaveBeenCalledWith("finalize_hotel_whatsapp_connection", expect.anything());
  });

  it("[parameters] passes exactly the documented p_* parameters, ciphertext/nonce/auth_tag as \\x-hex strings, p_expires_at always null", async () => {
    const client = fakeAdminClient({
      data: [{ id: "conn-1", connection_type: "coexistence", connected_at: "2026-01-01T00:00:00Z" }],
      error: null,
    });
    mockCreateAdminClient.mockReturnValue(client);
    const { persistWhatsAppConnection } = await import("./connectionPersistence");

    await persistWhatsAppConnection(INPUT);

    expect(client.rpc).toHaveBeenCalledWith("finalize_hotel_whatsapp_connection_with_secret", {
      p_hotel_id: INPUT.hotelId,
      p_waba_id: INPUT.wabaId,
      p_phone_number_id: INPUT.phoneNumberId,
      p_business_id: INPUT.businessId,
      p_connection_type: INPUT.connectionType,
      p_ciphertext: "\\xaabbcc",
      p_nonce: `\\x${"01".repeat(12)}`,
      p_auth_tag: `\\x${"02".repeat(16)}`,
      p_key_id: INPUT.keyId,
      p_encryption_version: INPUT.encryptionVersion,
      p_expires_at: null,
    });
  });

  it("[success] returns ok:true with only connectionType/connectedAt — never wabaId/phoneNumberId/businessId/crypto material", async () => {
    const client = fakeAdminClient({
      data: [{ id: "conn-1", connection_type: "coexistence", connected_at: "2026-01-01T00:00:00Z" }],
      error: null,
    });
    mockCreateAdminClient.mockReturnValue(client);
    const { persistWhatsAppConnection } = await import("./connectionPersistence");

    const result = await persistWhatsAppConnection(INPUT);
    expect(result).toEqual({ ok: true, data: { connectionType: "coexistence", connectedAt: "2026-01-01T00:00:00Z" } });
  });

  it("[RPC error] returns a sanitized error code, never the RPC's own error message", async () => {
    const client = fakeAdminClient({ data: null, error: { code: "23505" } });
    mockCreateAdminClient.mockReturnValue(client);
    const { persistWhatsAppConnection } = await import("./connectionPersistence");

    const result = await persistWhatsAppConnection(INPUT);
    expect(result).toEqual({ ok: false, errorCode: "whatsapp_connection_persistence_failed" });
  });

  it("[empty result set] treated as failure, never as a silent success", async () => {
    const client = fakeAdminClient({ data: [], error: null });
    mockCreateAdminClient.mockReturnValue(client);
    const { persistWhatsAppConnection } = await import("./connectionPersistence");

    const result = await persistWhatsAppConnection(INPUT);
    expect(result).toEqual({ ok: false, errorCode: "whatsapp_connection_persistence_failed" });
  });

  it("[no secret in error logging] console.error's own metadata never includes ciphertext/nonce/authTag/hotelId/phoneNumberId", () => {
    const fnStart = source.indexOf("export async function persistWhatsAppConnection");
    const fn = source.slice(fnStart);
    const logCalls = fn.match(/console\.error\([^;]*?\);/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      const metadataMatch = call.match(/\{[^{}]*\}(?![\s\S]*\{)/);
      expect(metadataMatch?.[0] ?? "").not.toMatch(/ciphertext|nonce|authTag|hotelId|phoneNumberId|businessId/);
    }
  });

  it("[no createAdminClient() reuse across calls beyond scope] uses the existing service-role helper, never a new Supabase key/mechanism", () => {
    expect(source).toMatch(/import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/);
    expect(source).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|new SupabaseClient|createClient\(/);
  });
});
