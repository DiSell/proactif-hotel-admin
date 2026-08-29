import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * requireClientAccess-guarded — same testing constraint as every other
 * Server Action in this repo (see src/features/hotelUsers/actions.test.ts's
 * own mocking pattern, reused verbatim below). requireClientAccess() itself
 * is already exhaustively covered at runtime in src/lib/auth/session.test.ts
 * — here it is mocked to return a fixed, controlled hotelId, precisely so
 * every test below can assert THAT hotelId (never one from signupResult)
 * is what actually reaches persistWhatsAppConnection().
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  const nextExport = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
}

const SESSION_HOTEL_ID = "session-hotel-a";
const mockRequireClientAccess = vi.fn(async () => ({ userId: "user-1", profile: { id: "user-1", role: "hotel_admin" }, hotelId: SESSION_HOTEL_ID }));
vi.mock("@/lib/auth/session", () => ({
  requireClientAccess: () => mockRequireClientAccess(),
}));

const mockFinalizeEmbeddedSignup = vi.fn();
vi.mock("@/lib/notifications/whatsapp/metaEmbeddedSignup", () => ({
  finalizeEmbeddedSignup: (...args: unknown[]) => mockFinalizeEmbeddedSignup(...args),
}));

const mockEncrypt = vi.fn();
vi.mock("@/lib/notifications/whatsapp/connectionSecretCrypto", () => ({
  encryptWhatsAppConnectionSecret: (...args: unknown[]) => mockEncrypt(...args),
}));

const mockPersist = vi.fn();
vi.mock("@/lib/notifications/whatsapp/connectionPersistence", () => ({
  persistWhatsAppConnection: (...args: unknown[]) => mockPersist(...args),
}));

afterEach(() => {
  mockRequireClientAccess.mockClear();
  mockFinalizeEmbeddedSignup.mockReset();
  mockEncrypt.mockReset();
  mockPersist.mockReset();
});

const PLAINTEXT_TOKEN = "fake-plaintext-business-token-never-real";

const INPUT = {
  code: "auth-code",
  signupResult: {
    event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" as const,
    wabaId: "waba-1",
    phoneNumberId: "phone-1",
    businessId: "biz-1",
  },
};

const FINALIZE_SUCCESS = {
  ok: true as const,
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  businessId: "biz-1",
  connectionType: "coexistence" as const,
  accessToken: PLAINTEXT_TOKEN,
};

const ENCRYPT_RESULT = {
  ciphertext: Buffer.from([1, 2, 3]),
  nonce: Buffer.from(Array(12).fill(9)),
  authTag: Buffer.from(Array(16).fill(8)),
  keyId: "v1",
  encryptionVersion: 1,
};

const PERSIST_SUCCESS = { ok: true as const, data: { connectionType: "coexistence" as const, connectedAt: "2026-01-01T00:00:00Z" } };

describe("receiveWhatsAppEmbeddedSignupCode — structural guarantees", () => {
  it("[hotelId never accepted as input] the exported function destructures only { code, signupResult } — never a hotelId parameter (task section 4's own forbidden signature)", () => {
    const signatureStart = source.indexOf("export async function receiveWhatsAppEmbeddedSignupCode(");
    const signatureEnd = source.indexOf(")", signatureStart);
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).not.toMatch(/hotelId/i);
    expect(signature).toMatch(/\{ code, signupResult \}: EmbeddedSignupCodeInput/);
  });

  it("[tenant derived from the session] calls requireClientAccess() with no arguments — a browser can never target a different hotel", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
  });

  it("[never requireHotelAccess/requireSuperadmin] this is a client-portal-only action", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).not.toMatch(/requireHotelAccess|requireSuperadmin/);
  });

  it("[missing/empty code rejected before the Meta chain is ever attempted]", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    const requireIndex = fn.indexOf("requireClientAccess()");
    const codeCheckIndex = fn.indexOf("!code.trim()");
    const chainIndex = fn.indexOf("finalizeEmbeddedSignup(");
    expect(codeCheckIndex).toBeGreaterThan(-1);
    expect(codeCheckIndex).toBeGreaterThan(requireIndex);
    expect(chainIndex).toBeGreaterThan(codeCheckIndex);
  });

  it("[the browser's signupResult hints are passed through as CLAIMED values, never as pre-validated ones]", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).toMatch(/claimedWabaId: signupResult\.wabaId/);
    expect(fn).toMatch(/claimedPhoneNumberId: signupResult\.phoneNumberId/);
    expect(fn).toMatch(/claimedBusinessId: signupResult\.businessId/);
  });

  it("[delegates persistence entirely] no Supabase client, no .from(), no direct .rpc() call anywhere in this file — persistWhatsAppConnection() is the sole write path", () => {
    expect(source).not.toMatch(/createAdminClient|createClient|\.from\(|\.rpc\(/);
    expect(source).toMatch(/import \{ persistWhatsAppConnection \} from "@\/lib\/notifications\/whatsapp\/connectionPersistence";/);
  });

  it("[code never logged] no console call's argument OBJECT ever references the `code` variable — a human-readable message may say the word \"code\" in prose", () => {
    const logCalls = source.match(/console\.(info|error|warn|log)\([^;]*?\);/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      const metadataMatch = call.match(/\{[^{}]*\}(?![\s\S]*\{)/);
      expect(metadataMatch?.[0] ?? "").not.toMatch(/\bcode\b/);
    }
  });

  it("[the plaintext token never appears in a console call's metadata object] only `finalized.accessToken`/`businessToken` are referenced structurally to pass it to encrypt(), never logged", () => {
    const logCalls = source.match(/console\.(info|error|warn|log)\([^;]*?\);/g) ?? [];
    for (const call of logCalls) {
      const metadataMatch = call.match(/\{[^{}]*\}(?![\s\S]*\{)/);
      expect(metadataMatch?.[0] ?? "").not.toMatch(/accessToken|businessToken/);
    }
  });

  it("[only a real, server-verified AND persisted success returns finalized:true] never a bare pass-through of the browser's own claim, never the literal DB status string", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCode");
    expect(fn).toMatch(/finalized: true/);
    expect(fn).not.toMatch(/status:\s*"active"/);
    expect(fn).not.toMatch(/connected:\s*true/);
  });
});

describe("receiveWhatsAppEmbeddedSignupCode — full orchestration (mocked Meta/crypto/RPC, no real call anywhere)", () => {
  it("[1] success: coexistence flow, fully mocked end to end, returns finalized:true with non-secret metadata only", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCode(INPUT);

    expect(result).toEqual({
      ok: true,
      data: { received: true, finalized: true, connectionType: "coexistence", connectedAt: "2026-01-01T00:00:00Z" },
    });
  });

  it("[2] the token is encrypted BEFORE the RPC is called — encrypt() is invoked strictly before persistWhatsAppConnection()", async () => {
    const callOrder: string[] = [];
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockImplementationOnce(() => {
      callOrder.push("encrypt");
      return ENCRYPT_RESULT;
    });
    mockPersist.mockImplementationOnce(async () => {
      callOrder.push("persist");
      return PERSIST_SUCCESS;
    });
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    await receiveWhatsAppEmbeddedSignupCode(INPUT);

    expect(callOrder).toEqual(["encrypt", "persist"]);
  });

  it("[3] the plaintext token is NEVER passed to persistWhatsAppConnection() — only ciphertext/nonce/authTag/keyId/encryptionVersion", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    await receiveWhatsAppEmbeddedSignupCode(INPUT);

    expect(mockPersist).toHaveBeenCalledTimes(1);
    const persistArg = mockPersist.mock.calls[0][0];
    expect(JSON.stringify(persistArg)).not.toMatch(new RegExp(PLAINTEXT_TOKEN));
    expect(persistArg).toEqual({
      hotelId: SESSION_HOTEL_ID,
      wabaId: "waba-1",
      phoneNumberId: "phone-1",
      businessId: "biz-1",
      connectionType: "coexistence",
      ciphertext: ENCRYPT_RESULT.ciphertext,
      nonce: ENCRYPT_RESULT.nonce,
      authTag: ENCRYPT_RESULT.authTag,
      keyId: ENCRYPT_RESULT.keyId,
      encryptionVersion: ENCRYPT_RESULT.encryptionVersion,
    });
  });

  it("[4] hotelId passed to persistWhatsAppConnection() comes ONLY from the session (requireClientAccess mock), never from signupResult", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    await receiveWhatsAppEmbeddedSignupCode(INPUT);

    expect(mockPersist.mock.calls[0][0].hotelId).toBe(SESSION_HOTEL_ID);
    expect(mockRequireClientAccess).toHaveBeenCalledTimes(1);
  });

  it("[10/11/12/13] any finalizeEmbeddedSignup failure (exchange/WABA/phone/subscribe) never encrypts or calls the RPC", async () => {
    for (const errorCode of ["code_exchange_failed", "waba_verification_failed", "phone_number_mismatch", "subscription_failed"] as const) {
      mockFinalizeEmbeddedSignup.mockResolvedValueOnce({ ok: false, errorCode });
      const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

      const result = await receiveWhatsAppEmbeddedSignupCode(INPUT);

      expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
      expect(mockEncrypt).not.toHaveBeenCalled();
      expect(mockPersist).not.toHaveBeenCalled();
      mockEncrypt.mockReset();
      mockPersist.mockReset();
    }
  });

  it("[14] encryption failure never calls the RPC, and never claims success", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockImplementationOnce(() => {
      throw new Error("whatsapp_secret_key_missing");
    });
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCode(INPUT);

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("[15] RPC failure returns the SAME generic client-facing error — never the RPC's own error code, never a secret", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce({ ok: false, errorCode: "whatsapp_connection_persistence_failed" });
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCode(INPUT);

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(JSON.stringify(result)).not.toMatch(/whatsapp_connection_persistence_failed/);
  });

  it("[16] the plaintext token never appears anywhere in the client-facing ActionResult, on success OR failure", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCode(INPUT);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(PLAINTEXT_TOKEN));
  });

  it("[17] the plaintext token never appears in any console.* call made during a real invocation", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    await receiveWhatsAppEmbeddedSignupCode(INPUT);

    const allCalls = [...infoSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toMatch(new RegExp(PLAINTEXT_TOKEN));
    }
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("[18] double callback (same code path invoked twice) is idempotent at the orchestration level — no de-duplication logic invented here, the RPC's own idempotent upsert (0026) is trusted as-is", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValue(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValue(ENCRYPT_RESULT);
    mockPersist.mockResolvedValue(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    const first = await receiveWhatsAppEmbeddedSignupCode(INPUT);
    const second = await receiveWhatsAppEmbeddedSignupCode(INPUT);

    expect(first).toEqual(second);
    expect(mockPersist).toHaveBeenCalledTimes(2);
    // Never a source-level dedup mechanism (a Set/Map/cache of prior calls) —
    // this action stays stateless, and correctness comes entirely from the
    // RPC's own upsert-by-phone_number_id behavior (already tested in
    // hotel_whatsapp_connection_secrets_check.sql).
    expect(source).not.toMatch(/new Set\(|new Map\(|idempotencyCache|seenPhoneNumbers/);
  });

  it("[19] unsupported finish events are still rejected before encryption/persistence", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce({ ok: false, errorCode: "unsupported_finish_event" });
    const { receiveWhatsAppEmbeddedSignupCode } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCode({ ...INPUT, signupResult: { ...INPUT.signupResult, event: "FINISH_OBO_MIGRATION" } });

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("[20] no real Meta call is possible from this test file — finalizeEmbeddedSignup is entirely mocked, no fetch stub is even installed", () => {
    expect(source).not.toMatch(/fetch\(/);
  });
});
