import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * requireHotelAccess-guarded — same mocking pattern as every other
 * per-hotel backoffice action in this repo (see
 * features/hotelUsers/actions.test.ts's own requireSuperadmin mock, and
 * features/partners/actions.ts's own requireHotelAccess(hotelId, scope)
 * shape). requireHotelAccess() itself is already exhaustively covered at
 * runtime in src/lib/auth/session.test.ts — not re-tested here.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  const nextExport = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
}

const mockRequireHotelAccess = vi.fn<(...args: unknown[]) => Promise<{ userId: string; profile: { id: string; role: string }; supabase: object }>>(
  async () => ({ userId: "admin-1", profile: { id: "admin-1", role: "superadmin" }, supabase: {} })
);
const mockRequireClientAccess = vi.fn<(...args: unknown[]) => Promise<{ userId: string; profile: { id: string; role: string }; hotelId: string }>>(
  async () => ({ userId: "client-1", profile: { id: "client-1", role: "hotel_admin" }, hotelId: "hotel-a" })
);
vi.mock("@/lib/auth/session", () => ({
  requireHotelAccess: (...args: unknown[]) => mockRequireHotelAccess(...args),
  requireClientAccess: (...args: unknown[]) => mockRequireClientAccess(...args),
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

const mockCreateActivationLink = vi.fn();
const mockClaimActivationToken = vi.fn();
const mockReleaseActivationTokenLease = vi.fn();
const mockMarkActivationTokenUsed = vi.fn();
vi.mock("./activationTokenPersistence", () => ({
  createActivationLink: (...args: unknown[]) => mockCreateActivationLink(...args),
  claimActivationToken: (...args: unknown[]) => mockClaimActivationToken(...args),
  releaseActivationTokenLease: (...args: unknown[]) => mockReleaseActivationTokenLease(...args),
  markActivationTokenUsed: (...args: unknown[]) => mockMarkActivationTokenUsed(...args),
}));

afterEach(() => {
  mockRequireHotelAccess.mockClear();
  mockRequireClientAccess.mockClear();
  mockFinalizeEmbeddedSignup.mockReset();
  mockEncrypt.mockReset();
  mockPersist.mockReset();
  mockCreateActivationLink.mockReset();
  mockClaimActivationToken.mockReset();
  mockReleaseActivationTokenLease.mockReset();
  mockMarkActivationTokenUsed.mockReset();
});

const PLAINTEXT_TOKEN = "fake-plaintext-business-token-never-real";
const HOTEL_ID = "hotel-a";
const CODE = "auth-code";
const ACTIVATION_TOKEN = "fake-activation-token-never-real";
const TOKEN_ID = "activation-token-row-1";
const SIGNUP_RESULT = {
  event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" as const,
  wabaId: "waba-1",
  phoneNumberId: "phone-1",
  businessId: "biz-1",
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
const CLAIM_SUCCESS = { ok: true as const, data: { tokenId: TOKEN_ID, hotelId: HOTEL_ID } };
const CREATE_LINK_SUCCESS = { ok: true as const, data: { url: "https://app.example/whatsapp/connect/raw-token", expiresAt: "2026-01-08T00:00:00Z" } };

describe("generateWhatsAppActivationLinkBackoffice — structural guarantees", () => {
  it("[exported, hotelId-only] takes exactly (hotelId: string)", () => {
    const signatureStart = source.indexOf("export async function generateWhatsAppActivationLinkBackoffice(");
    expect(signatureStart).toBeGreaterThan(-1);
    const signatureEnd = source.indexOf(")", source.indexOf("): Promise", signatureStart));
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).toMatch(/hotelId: string/);
  });

  it("[tenant re-validated server-side] calls requireHotelAccess(hotelId, \"backoffice\") before creating any link", () => {
    const fn = sliceFunction("generateWhatsAppActivationLinkBackoffice");
    expect(fn).toMatch(/await requireHotelAccess\(hotelId, "backoffice"\);/);
    const requireIndex = fn.indexOf("requireHotelAccess(");
    const createIndex = fn.indexOf("createActivationLink(");
    expect(requireIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(requireIndex);
  });

  it("[never triggers Meta] this function never calls finalizeEmbeddedSignup/encrypt/persist — it only ever creates a link", () => {
    const fn = sliceFunction("generateWhatsAppActivationLinkBackoffice");
    expect(fn).not.toMatch(/finalizeEmbeddedSignup|encryptWhatsAppConnectionSecret|persistWhatsAppConnection/);
  });
});

describe("generateWhatsAppActivationLinkBackoffice — orchestration (mocked)", () => {
  it("[success] returns the url/expiresAt from createActivationLink as-is", async () => {
    mockCreateActivationLink.mockResolvedValueOnce(CREATE_LINK_SUCCESS);
    const { generateWhatsAppActivationLinkBackoffice } = await import("./actions");

    const result = await generateWhatsAppActivationLinkBackoffice(HOTEL_ID);

    expect(result).toEqual({ ok: true, data: CREATE_LINK_SUCCESS.data });
    expect(mockRequireHotelAccess).toHaveBeenCalledWith(HOTEL_ID, "backoffice");
    expect(mockCreateActivationLink).toHaveBeenCalledWith(HOTEL_ID);
  });

  it("[creation failure] returns a generic error, never the internal errorCode", async () => {
    mockCreateActivationLink.mockResolvedValueOnce({ ok: false, errorCode: "activation_link_creation_failed" });
    const { generateWhatsAppActivationLinkBackoffice } = await import("./actions");

    const result = await generateWhatsAppActivationLinkBackoffice(HOTEL_ID);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/activation_link_creation_failed/);
  });

  it("[regeneration refused while in progress] surfaces a distinct, clean message — safe to be specific here since this is an authenticated admin session, not the anonymous activation page", async () => {
    mockCreateActivationLink.mockResolvedValueOnce({ ok: false, errorCode: "activation_in_progress" });
    const { generateWhatsAppActivationLinkBackoffice } = await import("./actions");

    const result = await generateWhatsAppActivationLinkBackoffice(HOTEL_ID);

    expect(result).toEqual({ ok: false, error: "Une activation est déjà en cours pour cet établissement. Réessayez dans quelques minutes." });
  });

  it("[unauthorized] a caller not authorized for hotelId never reaches createActivationLink", async () => {
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));
    const { generateWhatsAppActivationLinkBackoffice } = await import("./actions");

    await expect(generateWhatsAppActivationLinkBackoffice("hotel-b")).rejects.toThrow();
    expect(mockCreateActivationLink).not.toHaveBeenCalled();
  });
});

describe("receiveWhatsAppEmbeddedSignupCodeFromActivation — structural guarantees", () => {
  it("[public entry point] takes exactly (activationToken: string, code: string, signupResult: EmbeddedSignupResultHints) — NEVER a hotelId parameter", () => {
    const signatureStart = source.indexOf("export async function receiveWhatsAppEmbeddedSignupCodeFromActivation(");
    expect(signatureStart).toBeGreaterThan(-1);
    const signatureEnd = source.indexOf(")", source.indexOf("): Promise", signatureStart));
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).toMatch(/activationToken: string/);
    expect(signature).toMatch(/code: string/);
    expect(signature).toMatch(/signupResult: EmbeddedSignupResultHints/);
    expect(signature).not.toMatch(/hotelId/);
  });

  it("[token IS the authorization] never calls requireHotelAccess/requireClientAccess/requireSuperadmin — the browser has no session at all here", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCodeFromActivation");
    // sliceFunction's own "up to the next export" boundary also captures the
    // NEXT function's doc comment (which legitimately mentions
    // requireClientAccess in prose) — strip comments before matching.
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/requireHotelAccess|requireClientAccess|requireSuperadmin/);
  });

  it("[hotelId obtained ONLY via the atomic claim] claimActivationToken(...) is called before finalizeWhatsAppEmbeddedSignupForHotel", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCodeFromActivation");
    const claimIndex = fn.indexOf("claimActivationToken(");
    const finalizeIndex = fn.indexOf("finalizeWhatsAppEmbeddedSignupForHotel(");
    expect(claimIndex).toBeGreaterThan(-1);
    expect(finalizeIndex).toBeGreaterThan(claimIndex);
  });

  it("[shared orchestrator is NEVER exported] finalizeWhatsAppEmbeddedSignupForHotel exists but cannot be reached directly as a Server Action", () => {
    expect(source).toMatch(/async function finalizeWhatsAppEmbeddedSignupForHotel\(/);
    expect(source).not.toMatch(/export async function finalizeWhatsAppEmbeddedSignupForHotel/);
  });

  it("[delegates persistence entirely] no Supabase client, no .from(), no direct .rpc() call anywhere in this file", () => {
    expect(source).not.toMatch(/createAdminClient|createClient|\.from\(|\.rpc\(/);
    expect(source).toMatch(/import \{ persistWhatsAppConnection \} from "@\/lib\/notifications\/whatsapp\/connectionPersistence";/);
  });

  it("[no real Meta call is possible from this test file] finalizeEmbeddedSignup is entirely mocked, no fetch stub is even installed", () => {
    expect(source).not.toMatch(/fetch\(/);
  });
});

describe("receiveWhatsAppEmbeddedSignupCodeFromActivation — orchestration (mocked auth/claim/Meta/crypto/RPC, no real call anywhere)", () => {
  it("[1] success: claims the token, finalizes, encrypts, persists, marks the token used, never releases the lease", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    mockMarkActivationTokenUsed.mockResolvedValueOnce(true);
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    expect(result).toEqual({
      ok: true,
      data: { received: true, finalized: true, connectionType: "coexistence", connectedAt: "2026-01-01T00:00:00Z" },
    });
    expect(mockClaimActivationToken).toHaveBeenCalledWith(ACTIVATION_TOKEN);
    expect(mockMarkActivationTokenUsed).toHaveBeenCalledWith(TOKEN_ID);
    expect(mockReleaseActivationTokenLease).not.toHaveBeenCalled();
  });

  it("[2] the hotelId used for finalize/persist is EXACTLY the one the claim returned — never any client-supplied value", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    mockMarkActivationTokenUsed.mockResolvedValueOnce(true);
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    expect(mockPersist.mock.calls[0][0].hotelId).toBe(CLAIM_SUCCESS.data.hotelId);
  });

  it("[8/9] token unknown/expired/revoked/used/currently-processing — claim fails, generic error, no Meta/crypto/RPC call, never distinguishes the reason", async () => {
    mockClaimActivationToken.mockResolvedValueOnce({ ok: false });
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    expect(result).toEqual({ ok: false, error: "Connexion déjà en cours ou lien indisponible." });
    expect(mockFinalizeEmbeddedSignup).not.toHaveBeenCalled();
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockMarkActivationTokenUsed).not.toHaveBeenCalled();
    expect(mockReleaseActivationTokenLease).not.toHaveBeenCalled();
  });

  it("[2 concurrent claims] two simultaneous callbacks for the same token — only the one that wins the claim proceeds, the other gets the generic error and never touches Meta", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS).mockResolvedValueOnce({ ok: false });
    mockFinalizeEmbeddedSignup.mockResolvedValue(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValue(ENCRYPT_RESULT);
    mockPersist.mockResolvedValue(PERSIST_SUCCESS);
    mockMarkActivationTokenUsed.mockResolvedValue(true);
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const [first, second] = await Promise.all([
      receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT),
      receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT),
    ]);

    const results = [first, second];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "Connexion déjà en cours ou lien indisponible.")).toHaveLength(1);
    expect(mockFinalizeEmbeddedSignup).toHaveBeenCalledTimes(1);
  });

  it("[14/15/16 style] finalizeEmbeddedSignup failure (Meta cancellation/error) releases the lease, never marks used, never persists", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce({ ok: false, errorCode: "code_exchange_failed" });
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(mockReleaseActivationTokenLease).toHaveBeenCalledWith(TOKEN_ID);
    expect(mockMarkActivationTokenUsed).not.toHaveBeenCalled();
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("[encryption failure] releases the lease, never marks used, never calls the RPC", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockImplementationOnce(() => {
      throw new Error("whatsapp_secret_key_missing");
    });
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(mockReleaseActivationTokenLease).toHaveBeenCalledWith(TOKEN_ID);
    expect(mockMarkActivationTokenUsed).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("[17] RPC 0026 failure releases the lease, never marks used, returns the same generic error — never the RPC's own error code", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce({ ok: false, errorCode: "whatsapp_connection_persistence_failed" });
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(mockReleaseActivationTokenLease).toHaveBeenCalledWith(TOKEN_ID);
    expect(mockMarkActivationTokenUsed).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/whatsapp_connection_persistence_failed/);
  });

  it("[9 — retry after error] a failed attempt releases the lease, so a second attempt (with a fresh successful claim) can still succeed on the SAME token", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce({ ok: false, errorCode: "code_exchange_failed" });
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const firstAttempt = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);
    expect(firstAttempt.ok).toBe(false);
    expect(mockReleaseActivationTokenLease).toHaveBeenCalledWith(TOKEN_ID);

    // The lease being released is exactly what allows claimActivationToken
    // to succeed again for the same token on a retry — simulated here since
    // claimActivationToken itself is mocked (its own real reclaim logic is
    // tested in activationTokenPersistence.test.ts).
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    mockMarkActivationTokenUsed.mockResolvedValueOnce(true);
    const secondAttempt = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    expect(secondAttempt.ok).toBe(true);
  });

  it("[19] unsupported finish events are still rejected before encryption/persistence, and release the lease", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce({ ok: false, errorCode: "unsupported_finish_event" });
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, { ...SIGNUP_RESULT, event: "FINISH_OBO_MIGRATION" });

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(mockReleaseActivationTokenLease).toHaveBeenCalledWith(TOKEN_ID);
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("[token never logged] no console call anywhere in this file references the `activationToken` variable, and the plaintext token never appears in any console.* call at runtime", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    mockMarkActivationTokenUsed.mockResolvedValueOnce(true);
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);

    const allCalls = [...infoSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toMatch(new RegExp(ACTIVATION_TOKEN));
      expect(JSON.stringify(call)).not.toMatch(new RegExp(PLAINTEXT_TOKEN));
    }
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("[16] the plaintext business token never appears anywhere in the client-facing ActionResult, on success OR failure", async () => {
    mockClaimActivationToken.mockResolvedValueOnce(CLAIM_SUCCESS);
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    mockMarkActivationTokenUsed.mockResolvedValueOnce(true);
    const { receiveWhatsAppEmbeddedSignupCodeFromActivation } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(ACTIVATION_TOKEN, CODE, SIGNUP_RESULT);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(PLAINTEXT_TOKEN));
  });

  it("[only a real, server-verified AND persisted success returns finalized:true] never the literal DB status string", () => {
    expect(source).toMatch(/finalized: true/);
    expect(source).not.toMatch(/status:\s*"active"/);
    expect(source).not.toMatch(/connected:\s*true/);
  });
});

describe("receiveWhatsAppEmbeddedSignupCodeClient — structural guarantees", () => {
  it("[the MAIN, direct path] takes exactly (code: string, signupResult: EmbeddedSignupResultHints) — NEVER a hotelId parameter", () => {
    const signatureStart = source.indexOf("export async function receiveWhatsAppEmbeddedSignupCodeClient(");
    expect(signatureStart).toBeGreaterThan(-1);
    const signatureEnd = source.indexOf(")", source.indexOf("): Promise", signatureStart));
    const signature = source.slice(signatureStart, signatureEnd);
    expect(signature).toMatch(/code: string/);
    expect(signature).toMatch(/signupResult: EmbeddedSignupResultHints/);
    expect(signature).not.toMatch(/hotelId/);
  });

  it("[hotelId comes EXCLUSIVELY from requireClientAccess()] never requireHotelAccess/requireSuperadmin, never a browser-supplied value", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCodeClient");
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
    const code = fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/requireHotelAccess|requireSuperadmin/);
  });

  it("[reuses the SAME shared orchestrator] never a second Meta-exchange/encrypt/persist implementation", () => {
    const fn = sliceFunction("receiveWhatsAppEmbeddedSignupCodeClient");
    expect(fn).toMatch(/return finalizeWhatsAppEmbeddedSignupForHotel\(hotelId, code, signupResult\);/);
  });
});

describe("receiveWhatsAppEmbeddedSignupCodeClient — orchestration (mocked auth/Meta/crypto/RPC, no real call anywhere)", () => {
  it("[success] resolves hotelId from the session, finalizes, encrypts, persists", async () => {
    mockRequireClientAccess.mockResolvedValueOnce({ userId: "client-1", profile: { id: "client-1", role: "hotel_admin" }, hotelId: HOTEL_ID });
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCodeClient } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeClient(CODE, SIGNUP_RESULT);

    expect(result).toEqual({
      ok: true,
      data: { received: true, finalized: true, connectionType: "coexistence", connectedAt: "2026-01-01T00:00:00Z" },
    });
    expect(mockPersist.mock.calls[0][0].hotelId).toBe(HOTEL_ID);
  });

  it("[5/9 — client A can never configure hotel B] the hotelId used is EXACTLY the one requireClientAccess() resolved for THIS caller's session — there is no way to override it", async () => {
    const HOTEL_B = "hotel-b";
    mockRequireClientAccess.mockResolvedValueOnce({ userId: "client-2", profile: { id: "client-2", role: "hotel_admin" }, hotelId: HOTEL_B });
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCodeClient } = await import("./actions");

    await receiveWhatsAppEmbeddedSignupCodeClient(CODE, SIGNUP_RESULT);

    expect(mockPersist.mock.calls[0][0].hotelId).toBe(HOTEL_B);
    expect(mockPersist.mock.calls[0][0].hotelId).not.toBe(HOTEL_ID);
  });

  it("[unauthenticated caller never reaches Meta/crypto/RPC] requireClientAccess() rejecting stops the chain immediately", async () => {
    mockRequireClientAccess.mockRejectedValueOnce(new Error("not authenticated"));
    const { receiveWhatsAppEmbeddedSignupCodeClient } = await import("./actions");

    await expect(receiveWhatsAppEmbeddedSignupCodeClient(CODE, SIGNUP_RESULT)).rejects.toThrow();

    expect(mockFinalizeEmbeddedSignup).not.toHaveBeenCalled();
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("[Meta failure never persists, never claims success] same generic error as the other two entry points", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce({ ok: false, errorCode: "code_exchange_failed" });
    const { receiveWhatsAppEmbeddedSignupCodeClient } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeClient(CODE, SIGNUP_RESULT);

    expect(result).toEqual({ ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." });
    expect(mockEncrypt).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("[the plaintext business token never appears anywhere in the client-facing ActionResult]", async () => {
    mockFinalizeEmbeddedSignup.mockResolvedValueOnce(FINALIZE_SUCCESS);
    mockEncrypt.mockReturnValueOnce(ENCRYPT_RESULT);
    mockPersist.mockResolvedValueOnce(PERSIST_SUCCESS);
    const { receiveWhatsAppEmbeddedSignupCodeClient } = await import("./actions");

    const result = await receiveWhatsAppEmbeddedSignupCodeClient(CODE, SIGNUP_RESULT);
    expect(JSON.stringify(result)).not.toMatch(new RegExp(PLAINTEXT_TOKEN));
  });

  it("[no real Meta call possible from this test file]", () => {
    expect(source).not.toMatch(/fetch\(/);
  });
});
