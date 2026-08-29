import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Server-only AES-256-GCM primitive for the Meta Business Integration
 * System User access token per WhatsApp connection (0026's own
 * hotel_whatsapp_connection_secrets table stores ciphertext/nonce/auth_tag
 * ONLY — this file is where the plaintext ever exists, transiently, in a
 * Node process). Encryption happens here BEFORE
 * finalize_hotel_whatsapp_connection_with_secret() is ever called;
 * decryption happens here AFTER get_hotel_whatsapp_connection_secret()
 * returns ciphertext — this task builds ONLY the primitive itself, neither
 * RPC is called from this file or its tests (deliberately — see the task's
 * own scope).
 *
 * Never imported by anything reachable from the browser, the RAG/widget
 * pipeline, or an LLM prompt — same isolation discipline as the rest of
 * this directory (see isolation.test.ts). The plaintext token is never
 * logged, never included in a thrown error, and never returned anywhere
 * except as this module's own decrypt() return value to its direct,
 * server-side caller.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32; // AES-256
const NONCE_LENGTH_BYTES = 12; // GCM's own recommended nonce size
const AUTH_TAG_LENGTH_BYTES = 16;
const MAX_KEY_ID_LENGTH = 64;

/**
 * The only encryption format version this module currently produces or
 * accepts. A future format change would introduce v2 here — decrypt()
 * itself does not (and must not) guess how to handle a version it doesn't
 * recognize; see WHATSAPP_SECRET_VERSION_UNSUPPORTED below.
 */
export const CURRENT_CONNECTION_SECRET_ENCRYPTION_VERSION = 1;

/**
 * Closed, deterministic, sanitized error codes (task section 9) — the
 * error's own `message` is ALWAYS exactly the code string, never a key, a
 * plaintext token, a ciphertext, a nonce, or an auth tag. Callers that log
 * a caught error may safely log `error.code`/`error.message` — never any
 * other property of what they were operating on.
 */
export type WhatsAppSecretErrorCode =
  | "whatsapp_secret_key_missing"
  | "whatsapp_secret_key_invalid"
  | "whatsapp_secret_key_id_invalid"
  | "whatsapp_secret_encryption_failed"
  | "whatsapp_secret_decryption_failed"
  | "whatsapp_secret_version_unsupported";

export class WhatsAppSecretCryptoError extends Error {
  readonly code: WhatsAppSecretErrorCode;

  constructor(code: WhatsAppSecretErrorCode) {
    super(code);
    this.name = "WhatsAppSecretCryptoError";
    this.code = code;
  }
}

/**
 * Everything encrypt() produces and decrypt() consumes — deliberately
 * mirrors hotel_whatsapp_connection_secrets' own columns (0026) 1:1, so a
 * caller can pass this object's fields directly as that migration's RPC
 * parameters without any reshaping (not done in this task — see its own
 * scope note above). Never includes the plaintext token itself.
 */
export interface EncryptedWhatsAppConnectionSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string;
  encryptionVersion: number;
}

export interface EncryptWhatsAppConnectionSecretInput {
  /** The Meta Business Integration System User access token, in memory only for the duration of this call. */
  token: string;
  hotelId: string;
  phoneNumberId: string;
}

export interface DecryptWhatsAppConnectionSecretInput {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string;
  encryptionVersion: number;
  hotelId: string;
  phoneNumberId: string;
}

/**
 * Deterministic AAD (task section 4) — identical construction used for
 * both encrypt and decrypt, or GCM's own authentication tag check fails by
 * design. Deliberately NEVER uses connection_id: at encryption time (in
 * the Node process, before finalize_hotel_whatsapp_connection_with_secret()
 * is ever called) no connection_id exists yet — 0025/0026's own RPC is
 * what first allocates/resolves it. hotelId/phoneNumberId are both already
 * known and trusted at encryption time (hotelId from requireClientAccess(),
 * phoneNumberId already independently verified against Meta — see
 * metaEmbeddedSignup.ts, a separate task), and both are re-supplied
 * identically at decryption time from the same connection row, so the
 * server can always reconstruct this value — it is never stored anywhere.
 */
export function buildConnectionSecretAad(params: { encryptionVersion: number; hotelId: string; phoneNumberId: string }): Buffer {
  return Buffer.from(`proactif-whatsapp-token:v${params.encryptionVersion}:${params.hotelId}:${params.phoneNumberId}`, "utf8");
}

interface ResolvedKey {
  key: Buffer;
  keyId: string;
}

/**
 * Rejects "CURRENT"/"PREVIOUS" as a persisted key_id (task section 6): those
 * are roles the Node-side env configuration assigns to a key at read time,
 * never a fact this codebase should ever write into a database row — see
 * 0026_hotel_whatsapp_connection_secrets.sql's own header comment on
 * key_id's intended immutable-version-label meaning (e.g. "v1", "v2").
 */
function validateKeyId(rawKeyId: string | undefined): string {
  const keyId = rawKeyId?.trim();
  if (!keyId || keyId.length > MAX_KEY_ID_LENGTH) {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_key_id_invalid");
  }
  if (keyId.toUpperCase() === "CURRENT" || keyId.toUpperCase() === "PREVIOUS") {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_key_id_invalid");
  }
  return keyId;
}

function decodeKeyB64(b64: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(b64, "base64");
  } catch {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_key_invalid");
  }
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_key_invalid");
  }
  return key;
}

/**
 * Reads WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64/_ID fresh on every call
 * — no module-level caching of the decoded key, so a key rotated in the
 * environment takes effect on the very next call without a process
 * restart being required for correctness (a restart may still be needed
 * operationally depending on how the platform injects env vars, but this
 * module itself never goes stale on its own).
 */
function loadCurrentKey(): ResolvedKey {
  const b64 = process.env.WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_B64;
  const rawKeyId = process.env.WHATSAPP_CONNECTION_SECRET_KEY_CURRENT_ID;
  if (!b64?.trim() || !rawKeyId?.trim()) {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_key_missing");
  }
  return { key: decodeKeyB64(b64), keyId: validateKeyId(rawKeyId) };
}

/**
 * Optional. Both PREVIOUS_B64 and PREVIOUS_ID must be set TOGETHER or
 * NEITHER (task section 6) — one present without the other is a
 * configuration error, never a silent partial-rotation state. Returns
 * `null` only when BOTH are genuinely absent (no rotation window active).
 */
function loadPreviousKey(): ResolvedKey | null {
  const b64 = process.env.WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_B64;
  const rawKeyId = process.env.WHATSAPP_CONNECTION_SECRET_KEY_PREVIOUS_ID;
  const hasB64 = Boolean(b64?.trim());
  const hasKeyId = Boolean(rawKeyId?.trim());

  if (!hasB64 && !hasKeyId) return null;
  if (hasB64 !== hasKeyId) {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_key_invalid");
  }
  return { key: decodeKeyB64(b64 as string), keyId: validateKeyId(rawKeyId) };
}

/**
 * Encrypts a Meta business token for storage (task section 7). Always uses
 * the CURRENT key/version — a previous key is only ever a DECRYPT-time
 * concept (task section 6), never used to encrypt anything new. Never
 * logs the plaintext token, the derived key, or the resulting ciphertext.
 */
export function encryptWhatsAppConnectionSecret(input: EncryptWhatsAppConnectionSecretInput): EncryptedWhatsAppConnectionSecret {
  const { key, keyId } = loadCurrentKey();
  const encryptionVersion = CURRENT_CONNECTION_SECRET_ENCRYPTION_VERSION;
  const aad = buildConnectionSecretAad({ encryptionVersion, hotelId: input.hotelId, phoneNumberId: input.phoneNumberId });
  const nonce = randomBytes(NONCE_LENGTH_BYTES);

  try {
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_LENGTH_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(input.token, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { ciphertext, nonce, authTag, keyId, encryptionVersion };
  } catch {
    // Never rethrows the original error: a node:crypto failure message can
    // echo back parts of its input in some Node versions/error paths.
    throw new WhatsAppSecretCryptoError("whatsapp_secret_encryption_failed");
  }
}

/**
 * Decrypts a stored secret (task section 8). Fails closed on every
 * inconsistency — wrong hotelId/phoneNumberId (AAD mismatch), an unknown
 * keyId, an unsupported encryptionVersion, or any tampering with
 * ciphertext/nonce/authTag all surface as the SAME sanitized
 * `whatsapp_secret_decryption_failed` (or a more specific validation code
 * for a malformed shape, checked before any key material is even touched)
 * — never a plaintext fallback, never a partial/best-effort result.
 */
export function decryptWhatsAppConnectionSecret(input: DecryptWhatsAppConnectionSecretInput): string {
  if (input.encryptionVersion !== CURRENT_CONNECTION_SECRET_ENCRYPTION_VERSION) {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_version_unsupported");
  }
  if (input.nonce.length !== NONCE_LENGTH_BYTES || input.authTag.length !== AUTH_TAG_LENGTH_BYTES || input.ciphertext.length === 0) {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_decryption_failed");
  }

  const current = loadCurrentKey();
  const previous = loadPreviousKey();

  let key: Buffer;
  if (input.keyId === current.keyId) {
    key = current.key;
  } else if (previous && input.keyId === previous.keyId) {
    key = previous.key;
  } else {
    throw new WhatsAppSecretCryptoError("whatsapp_secret_key_id_invalid");
  }

  const aad = buildConnectionSecretAad({
    encryptionVersion: input.encryptionVersion,
    hotelId: input.hotelId,
    phoneNumberId: input.phoneNumberId,
  });

  try {
    const decipher = createDecipheriv(ALGORITHM, key, input.nonce, { authTagLength: AUTH_TAG_LENGTH_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(input.authTag);
    const plaintext = Buffer.concat([decipher.update(input.ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // GCM's own authentication failure (wrong key/AAD/tampered bytes) all
    // throw here — deliberately collapsed into ONE sanitized code, never
    // revealing which specific check failed (that would leak information
    // useful to an attacker probing the boundary).
    throw new WhatsAppSecretCryptoError("whatsapp_secret_decryption_failed");
  }
}
