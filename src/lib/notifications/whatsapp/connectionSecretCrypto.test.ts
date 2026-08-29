import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildConnectionSecretAad,
  CURRENT_CONNECTION_SECRET_ENCRYPTION_VERSION,
  decryptWhatsAppConnectionSecret,
  encryptWhatsAppConnectionSecret,
  WhatsAppSecretCryptoError,
} from "./connectionSecretCrypto";

/**
 * FAKE, test-only 32-byte keys — never real secrets, never used outside
 * this file. Deterministic (not randomBytes) so a failing assertion's
 * diff is stable and readable.
 */
const CURRENT_KEY_B64 = Buffer.alloc(32, 0x11).toString("base64");
const CURRENT_KEY_ID = "v1";
const PREVIOUS_KEY_B64 = Buffer.alloc(32, 0x22).toString("base64");
const PREVIOUS_KEY_ID = "v0";

const HOTEL_ID = "11111111-1111-1111-1111-111111111111";
const PHONE_NUMBER_ID = "phone-123456";
const TOKEN = "fake-business-integration-system-user-token-not-real";

function stubCurrentKey(): void {
  vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64", CURRENT_KEY_B64);
  vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_ID", CURRENT_KEY_ID);
}

beforeEach(() => {
  stubCurrentKey();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptWhatsAppConnectionSecret / decryptWhatsAppConnectionSecret — round trip", () => {
  it("[1] decrypt(encrypt(token)) restores the exact plaintext", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    const decrypted = decryptWhatsAppConnectionSecret({ ...encrypted, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(decrypted).toBe(TOKEN);
  });

  it("[2] ciphertext is never equal to the plaintext bytes", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(encrypted.ciphertext.toString("utf8")).not.toBe(TOKEN);
    expect(encrypted.ciphertext.equals(Buffer.from(TOKEN, "utf8"))).toBe(false);
  });

  it("[3] nonce is exactly 12 bytes", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(encrypted.nonce).toHaveLength(12);
  });

  it("[4] authTag is exactly 16 bytes", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(encrypted.authTag).toHaveLength(16);
  });

  it("[5] encryptionVersion is 1", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(encrypted.encryptionVersion).toBe(1);
    expect(encrypted.encryptionVersion).toBe(CURRENT_CONNECTION_SECRET_ENCRYPTION_VERSION);
  });

  it("[6] keyId is the configured current key id", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(encrypted.keyId).toBe(CURRENT_KEY_ID);
  });

  it("[7/8] two encryptions of the same token produce different nonces, and therefore different ciphertexts", () => {
    const first = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    const second = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });
});

describe("buildConnectionSecretAad — deterministic contract", () => {
  it("matches the exact documented format, UTF-8 encoded", () => {
    const aad = buildConnectionSecretAad({ encryptionVersion: 1, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(aad.toString("utf8")).toBe(`proactif-whatsapp-token:v1:${HOTEL_ID}:${PHONE_NUMBER_ID}`);
  });

  it("never references connection_id — the value simply isn't a parameter this function accepts", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "connectionSecretCrypto.ts"), "utf8");
    const fnStart = source.indexOf("export function buildConnectionSecretAad");
    const fnEnd = source.indexOf("\n}", fnStart);
    const fn = source.slice(fnStart, fnEnd);
    expect(fn).not.toMatch(/connection_id|connectionId/);
  });
});

describe("decryptWhatsAppConnectionSecret — fail-closed on every inconsistency", () => {
  it("[9] wrong hotelId fails", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(() =>
      decryptWhatsAppConnectionSecret({ ...encrypted, hotelId: "22222222-2222-2222-2222-222222222222", phoneNumberId: PHONE_NUMBER_ID })
    ).toThrow(WhatsAppSecretCryptoError);
  });

  it("[10] wrong phoneNumberId fails", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(() => decryptWhatsAppConnectionSecret({ ...encrypted, hotelId: HOTEL_ID, phoneNumberId: "phone-999999" })).toThrow(
      WhatsAppSecretCryptoError
    );
  });

  it("[11] wrong encryptionVersion fails, with the dedicated version_unsupported code", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    try {
      decryptWhatsAppConnectionSecret({ ...encrypted, encryptionVersion: 2, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
      throw new Error("expected decrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSecretCryptoError);
      expect((err as WhatsAppSecretCryptoError).code).toBe("whatsapp_secret_version_unsupported");
    }
  });

  it("[12] tampered authTag fails", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    const tamperedAuthTag = Buffer.from(encrypted.authTag);
    tamperedAuthTag[0] ^= 0xff;
    expect(() =>
      decryptWhatsAppConnectionSecret({ ...encrypted, authTag: tamperedAuthTag, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID })
    ).toThrow(WhatsAppSecretCryptoError);
  });

  it("[13] tampered ciphertext fails", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    const tamperedCiphertext = Buffer.from(encrypted.ciphertext);
    tamperedCiphertext[0] ^= 0xff;
    expect(() =>
      decryptWhatsAppConnectionSecret({ ...encrypted, ciphertext: tamperedCiphertext, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID })
    ).toThrow(WhatsAppSecretCryptoError);
  });

  it("[14] tampered nonce fails", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    const tamperedNonce = Buffer.from(encrypted.nonce);
    tamperedNonce[0] ^= 0xff;
    expect(() =>
      decryptWhatsAppConnectionSecret({ ...encrypted, nonce: tamperedNonce, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID })
    ).toThrow(WhatsAppSecretCryptoError);
  });

  it("[15] the actual key material changing under the SAME keyId fails (a genuinely wrong key)", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    // Same key ID string, but the underlying key bytes are now different —
    // simulates an operator error (wrong key material deployed under an
    // unchanged id), which must fail exactly like a tampered ciphertext.
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64", Buffer.alloc(32, 0x99).toString("base64"));
    expect(() => decryptWhatsAppConnectionSecret({ ...encrypted, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID })).toThrow(
      WhatsAppSecretCryptoError
    );
  });

  it("[16] an unknown keyId (matches neither current nor previous) fails with key_id_invalid", () => {
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    try {
      decryptWhatsAppConnectionSecret({ ...encrypted, keyId: "v999", hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
      throw new Error("expected decrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSecretCryptoError);
      expect((err as WhatsAppSecretCryptoError).code).toBe("whatsapp_secret_key_id_invalid");
    }
  });
});

describe("key configuration validation", () => {
  it("[17] a current key that does not decode to exactly 32 bytes throws whatsapp_secret_key_invalid", () => {
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64", Buffer.alloc(16, 0x11).toString("base64"));
    try {
      encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
      throw new Error("expected encrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSecretCryptoError);
      expect((err as WhatsAppSecretCryptoError).code).toBe("whatsapp_secret_key_invalid");
    }
  });

  it("[18] a missing current key throws whatsapp_secret_key_missing", () => {
    vi.unstubAllEnvs();
    try {
      encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
      throw new Error("expected encrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSecretCryptoError);
      expect((err as WhatsAppSecretCryptoError).code).toBe("whatsapp_secret_key_missing");
    }
  });

  it("[19] an empty current key id throws", () => {
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_ID", "   ");
    expect(() => encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID })).toThrow(
      WhatsAppSecretCryptoError
    );
  });

  it("[6b] \"CURRENT\"/\"PREVIOUS\" are rejected as a persisted key id, even if otherwise well-formed", () => {
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_ID", "CURRENT");
    try {
      encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
      throw new Error("expected encrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSecretCryptoError);
      expect((err as WhatsAppSecretCryptoError).code).toBe("whatsapp_secret_key_id_invalid");
    }
  });

  it("[20] a previous key with only ONE of B64/ID set is a configuration error", () => {
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_B64", PREVIOUS_KEY_B64);
    // PREVIOUS_ID deliberately left unset.
    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    try {
      decryptWhatsAppConnectionSecret({ ...encrypted, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
      throw new Error("expected decrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSecretCryptoError);
      expect((err as WhatsAppSecretCryptoError).code).toBe("whatsapp_secret_key_invalid");
    }
  });
});

describe("key rotation", () => {
  it("[21] a secret encrypted under a key that has since become PREVIOUS still decrypts correctly", () => {
    // Encrypt while the fake key is CURRENT.
    const encryptedUnderOldKey = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(encryptedUnderOldKey.keyId).toBe(CURRENT_KEY_ID);

    // Rotate: the old key/id become PREVIOUS, a brand-new key/id become CURRENT.
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_B64", CURRENT_KEY_B64);
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_ID", CURRENT_KEY_ID);
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64", PREVIOUS_KEY_B64);
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_ID", PREVIOUS_KEY_ID);

    const decrypted = decryptWhatsAppConnectionSecret({ ...encryptedUnderOldKey, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(decrypted).toBe(TOKEN);
  });

  it("new encryptions after rotation use the NEW current key id, never the previous one", () => {
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_B64", CURRENT_KEY_B64);
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_ID", CURRENT_KEY_ID);
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64", PREVIOUS_KEY_B64);
    vi.stubEnv("WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_ID", PREVIOUS_KEY_ID);

    const encrypted = encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
    expect(encrypted.keyId).toBe(PREVIOUS_KEY_ID);
  });
});

describe("no secret ever leaks through an error, a log, or a public env var", () => {
  it("[22] every thrown error's message is exactly one of the closed code strings — never a key, token, or raw crypto byte", () => {
    const closedCodes = [
      "whatsapp_secret_key_missing",
      "whatsapp_secret_key_invalid",
      "whatsapp_secret_key_id_invalid",
      "whatsapp_secret_encryption_failed",
      "whatsapp_secret_decryption_failed",
      "whatsapp_secret_version_unsupported",
    ];

    vi.unstubAllEnvs();
    try {
      encryptWhatsAppConnectionSecret({ token: TOKEN, hotelId: HOTEL_ID, phoneNumberId: PHONE_NUMBER_ID });
      throw new Error("expected encrypt to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WhatsAppSecretCryptoError);
      expect(closedCodes).toContain((err as Error).message);
      expect((err as Error).message).not.toMatch(new RegExp(TOKEN));
    }
  });

  it("[23] this module never calls console.* anywhere — no accidental plaintext/key logging path exists at all", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "connectionSecretCrypto.ts"), "utf8");
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)\(/);
  });

  it("[24] this module never reads a NEXT_PUBLIC_ variable, and never references any WHATSAPP_META_* transport-layer secret", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "connectionSecretCrypto.ts"), "utf8");
    expect(source).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
    expect(source).not.toMatch(/WHATSAPP_META_ACCESS_TOKEN|WHATSAPP_META_APP_SECRET|WHATSAPP_META_VERIFY_TOKEN/);
  });

  it("[24b] .env.example documents the new key variables without NEXT_PUBLIC_ and without a real value", () => {
    const envExample = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env.example"), "utf8");
    const keyLines = envExample.split("\n").filter((line) => /^#?\s*WHATSAPP_CONNECTION_SECRET_KEY_/.test(line.trim()));
    expect(keyLines.length).toBeGreaterThanOrEqual(2); // at least CURRENT_B64 + CURRENT_ID
    for (const line of keyLines) {
      expect(line).not.toMatch(/NEXT_PUBLIC_/);
      expect(line).not.toMatch(/WHATSAPP_CONNECTION_SECRET_KEY_(CURRENT|PREVIOUS)_(B64|ID)=.+\S/);
    }
  });
});
