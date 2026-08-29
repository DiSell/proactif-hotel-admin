"use server";

import { requireClientAccess } from "@/lib/auth/session";
import { finalizeEmbeddedSignup } from "@/lib/notifications/whatsapp/metaEmbeddedSignup";
import { encryptWhatsAppConnectionSecret } from "@/lib/notifications/whatsapp/connectionSecretCrypto";
import { persistWhatsAppConnection } from "@/lib/notifications/whatsapp/connectionPersistence";
import type { ActionResult } from "@/lib/actionResult";
import type { EmbeddedSignupFinishEvent, HotelWhatsAppConnectionType } from "./types";

/**
 * Tenant is ALWAYS the caller's own session (requireClientAccess()) — never
 * a parameter. This function deliberately has no `hotelId` argument: a
 * browser can send whatever code/signupResult it wants, but it can never
 * target a different hotel's row (task section 4's own explicit forbidden
 * signature: `receiveWhatsAppEmbeddedSignupCode(hotelId, code)`).
 *
 * The full server-only orchestration (task: "BRANCHER LA FINALISATION
 * EMBEDDED SIGNUP..."):
 *   1. finalizeEmbeddedSignup() — exchange code, verify WABA, verify
 *      phone_number_id, subscribe app (metaEmbeddedSignup.ts). Returns the
 *      business token to THIS function only, ephemerally.
 *   2. encryptWhatsAppConnectionSecret() — AES-256-GCM, the plaintext token
 *      never leaves this function's own local scope.
 *   3. persistWhatsAppConnection() — the ONLY call to
 *      finalize_hotel_whatsapp_connection_with_secret() (0026); never the
 *      historical finalize_hotel_whatsapp_connection() (0025) directly —
 *      service_role itself can no longer execute that one since 0026's own
 *      hardening.
 * Any failure at any step returns the SAME generic, sanitized message —
 * never which step failed, never a Graph API/RPC error body, never any
 * crypto material. A connection is reported as finalized ONLY once all
 * three steps have genuinely succeeded — never from the browser's own
 * postMessage/FB.login response alone.
 */
export interface EmbeddedSignupReceipt {
  received: true;
  /**
   * true ONLY when the connection is now genuinely ACTIVE and PERSISTED:
   * Meta re-verified the WABA/phone_number_id/app subscription, the
   * business token was encrypted, AND
   * finalize_hotel_whatsapp_connection_with_secret() committed both the
   * connection and its secret atomically (0026). This is a real, durable
   * state — no caller needs to treat this as provisional.
   */
  finalized: boolean;
  /** Non-secret metadata only — never wabaId/phoneNumberId/businessId/any crypto material (minimization principle). */
  connectionType?: HotelWhatsAppConnectionType;
  connectedAt?: string;
}

export interface EmbeddedSignupCodeInput {
  /** From FB.login()'s own JS callback (response.authResponse.code) — never from postMessage. */
  code: string;
  /**
   * Meta's own postMessage hints — UNTRUSTED (task section 5): display-only
   * until finalizeEmbeddedSignup() re-verifies each one against Meta. Never
   * used, on their own, to decide anything beyond "which chain to attempt".
   */
  signupResult: {
    event: EmbeddedSignupFinishEvent;
    wabaId: string | null;
    phoneNumberId: string | null;
    businessId: string | null;
  };
}

/** Deliberately generic (task section 2/12) — never reveals which Meta/crypto/RPC step failed, never a response body, never any secret. */
const GENERIC_FINALIZATION_ERROR = "La connexion WhatsApp n'a pas pu être finalisée.";

export async function receiveWhatsAppEmbeddedSignupCode({ code, signupResult }: EmbeddedSignupCodeInput): Promise<ActionResult<EmbeddedSignupReceipt>> {
  // hotelId is derived ENTIRELY from the authenticated client-portal
  // session (see requireClientAccess()'s own doc comment: it reads
  // hotel_users for the logged-in userId) — there is no parameter here a
  // browser could use to target a different hotel's connection, and it is
  // NEVER taken from Meta's own data (task section 3).
  const { hotelId } = await requireClientAccess();

  if (typeof code !== "string" || !code.trim()) {
    return { ok: false, error: "Code d'autorisation Meta manquant." };
  }

  const finalized = await finalizeEmbeddedSignup({
    code,
    finishEvent: signupResult.event,
    claimedWabaId: signupResult.wabaId,
    claimedPhoneNumberId: signupResult.phoneNumberId,
    claimedBusinessId: signupResult.businessId,
  });

  if (!finalized.ok) {
    console.info("receiveWhatsAppEmbeddedSignupCode: Meta-side finalization did not complete", { hotelId, errorCode: finalized.errorCode });
    return { ok: false, error: GENERIC_FINALIZATION_ERROR };
  }

  // The business token exists in plaintext ONLY in this local variable,
  // from here until the encrypt call below returns — never logged, never
  // put in an Error, never assigned anywhere else, never returned from
  // this function.
  const businessToken = finalized.accessToken;

  let encrypted;
  try {
    encrypted = encryptWhatsAppConnectionSecret({ token: businessToken, hotelId, phoneNumberId: finalized.phoneNumberId });
  } catch (err) {
    // WhatsAppSecretCryptoError's own message is already a closed,
    // sanitized code (never a key/plaintext) — safe to log as-is.
    console.info("receiveWhatsAppEmbeddedSignupCode: encryption failed", { hotelId, errorCode: (err as Error).message });
    return { ok: false, error: GENERIC_FINALIZATION_ERROR };
  }

  const persisted = await persistWhatsAppConnection({
    hotelId,
    wabaId: finalized.wabaId,
    phoneNumberId: finalized.phoneNumberId,
    businessId: finalized.businessId,
    connectionType: finalized.connectionType,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    authTag: encrypted.authTag,
    keyId: encrypted.keyId,
    encryptionVersion: encrypted.encryptionVersion,
  });

  if (!persisted.ok) {
    console.info("receiveWhatsAppEmbeddedSignupCode: persistence failed", { hotelId, errorCode: persisted.errorCode });
    return { ok: false, error: GENERIC_FINALIZATION_ERROR };
  }

  console.info("receiveWhatsAppEmbeddedSignupCode: connection finalized and persisted", { hotelId });

  return {
    ok: true,
    data: { received: true, finalized: true, connectionType: persisted.data.connectionType, connectedAt: persisted.data.connectedAt },
  };
}
