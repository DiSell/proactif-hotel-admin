"use server";

import { requireHotelAccess } from "@/lib/auth/session";
import { finalizeEmbeddedSignup } from "@/lib/notifications/whatsapp/metaEmbeddedSignup";
import { encryptWhatsAppConnectionSecret } from "@/lib/notifications/whatsapp/connectionSecretCrypto";
import { persistWhatsAppConnection } from "@/lib/notifications/whatsapp/connectionPersistence";
import {
  createActivationLink,
  claimActivationToken,
  releaseActivationTokenLease,
  markActivationTokenUsed,
  type ActivationLink,
} from "./activationTokenPersistence";
import type { ActionResult } from "@/lib/actionResult";
import type { EmbeddedSignupFinishEvent, HotelWhatsAppConnectionType } from "./types";

/**
 * WhatsApp Business connection now lives in the ADMIN dashboard
 * (/etablissements/[id]/whatsapp), never in the client portal — the client
 * portal's own /client/whatsapp page and its ClientSidebarNav entry have
 * been removed entirely. The admin dashboard itself no longer triggers
 * Meta's Embedded Signup directly either: it only generates/copies an
 * activation LINK (generateWhatsAppActivationLinkBackoffice below); the
 * hotel's own WhatsApp Business owner is the one who opens that link
 * (src/app/whatsapp/connect/[token]/page.tsx, no Proactif account needed)
 * and completes Embedded Signup there.
 *
 * ONE shared backend orchestration remains regardless of entry point:
 * this file's own finalizeWhatsAppEmbeddedSignupForHotel() below runs the
 * exact same Meta-exchange -> encrypt -> persist chain — only the
 * AUTHORIZATION layer differs between the two callers (an authenticated
 * admin session re-verified by requireHotelAccess() when GENERATING a
 * link, versus an anonymous activation-token claim that resolves hotelId
 * server-side when CONSUMING one) — never two competing implementations of
 * the Meta/crypto/persistence chain itself.
 */
export interface EmbeddedSignupReceipt {
  received: true;
  /**
   * true ONLY when the connection is now genuinely ACTIVE and PERSISTED:
   * Meta re-verified the WABA/phone_number_id/app subscription, the
   * business token was encrypted, AND
   * finalize_hotel_whatsapp_connection_with_secret() (0026) committed both
   * the connection and its secret atomically. This is a real, durable
   * state — no caller needs to treat this as provisional.
   */
  finalized: boolean;
  /** Non-secret metadata only — never wabaId/phoneNumberId/businessId/any crypto material (minimization principle). */
  connectionType?: HotelWhatsAppConnectionType;
  connectedAt?: string;
}

export interface EmbeddedSignupResultHints {
  event: EmbeddedSignupFinishEvent;
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
}

/** Deliberately generic — never reveals which Meta/crypto/RPC step failed, never a response body, never any secret. */
const GENERIC_FINALIZATION_ERROR = "La connexion WhatsApp n'a pas pu être finalisée.";

/**
 * The shared server-only orchestrator (task: "extraire un orchestrateur
 * serveur réutilisable"). Receives a hotelId ALREADY authorized by its
 * caller — this function itself performs NO authorization check and is
 * deliberately NOT exported, exactly like every other
 * `*Internal`-shaped orchestrator in this codebase (see
 * features/partners/actions.ts's own doc comment on the same pattern) —
 * so it can never be reached directly as a Server Action, only through
 * one of the thin, scope-specific wrappers below.
 *
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
 * crypto material.
 */
async function finalizeWhatsAppEmbeddedSignupForHotel(
  hotelId: string,
  code: string,
  signupResult: EmbeddedSignupResultHints
): Promise<ActionResult<EmbeddedSignupReceipt>> {
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
    console.info("finalizeWhatsAppEmbeddedSignupForHotel: Meta-side finalization did not complete", { hotelId, errorCode: finalized.errorCode });
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
    console.info("finalizeWhatsAppEmbeddedSignupForHotel: encryption failed", { hotelId, errorCode: (err as Error).message });
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
    console.info("finalizeWhatsAppEmbeddedSignupForHotel: persistence failed", { hotelId, errorCode: persisted.errorCode });
    return { ok: false, error: GENERIC_FINALIZATION_ERROR };
  }

  console.info("finalizeWhatsAppEmbeddedSignupForHotel: connection finalized and persisted", { hotelId });

  return {
    ok: true,
    data: { received: true, finalized: true, connectionType: persisted.data.connectionType, connectedAt: persisted.data.connectedAt },
  };
}

/** Deliberately generic — a visitor with an invalid/expired/revoked/used/currently-processing token must never be able to distinguish which of those applies (task section 1: "ne jamais révéler l'état interne précis à un visiteur non authentifié"). */
const GENERIC_ACTIVATION_CLAIM_ERROR = "Connexion déjà en cours ou lien indisponible.";

/**
 * Admin-only: generates a fresh activation link for one hotel. Never
 * triggers Meta's Embedded Signup itself — that only ever happens on the
 * public /whatsapp/connect/[token] page, reached by the hotel's own
 * WhatsApp Business owner, never by this admin session.
 *
 * `hotelId` is re-verified server-side by requireHotelAccess(hotelId,
 * "backoffice") before any token is created — same discipline as every
 * other per-hotel backoffice action in this codebase (see e.g.
 * features/partners/actions.ts::createHotelPartnerBackoffice(hotelId, ...)):
 * a browser can send whatever hotelId it wants, but it can never make this
 * function act on a hotel the caller isn't genuinely authorized for.
 */
export async function generateWhatsAppActivationLinkBackoffice(hotelId: string): Promise<ActionResult<ActivationLink>> {
  await requireHotelAccess(hotelId, "backoffice");

  const created = await createActivationLink(hotelId);
  if (!created.ok) {
    // Admin session, not the anonymous activation page — safe to be
    // specific here (unlike GENERIC_ACTIVATION_CLAIM_ERROR below).
    if (created.errorCode === "activation_in_progress") {
      return { ok: false, error: "Une activation est déjà en cours pour cet établissement. Réessayez dans quelques minutes." };
    }
    return { ok: false, error: "Le lien d'activation n'a pas pu être généré." };
  }
  return { ok: true, data: created.data };
}

/**
 * The ONLY externally-callable entry point into the WhatsApp Embedded
 * Signup finalization chain — reached exclusively from the PUBLIC
 * activation page (src/app/whatsapp/connect/[token]/page.tsx), never from
 * an authenticated admin/client session. `activationToken` IS the sole
 * authorization: there is no requireHotelAccess/requireClientAccess call
 * here at all, and hotelId is NEVER accepted as a parameter — it comes
 * EXCLUSIVELY from claimActivationToken()'s own atomic claim (task section
 * 5), never from anything the browser supplies.
 *
 * Concurrency (task sections 1/2/3/12): the lease is claimed atomically
 * BEFORE any Meta call is made, so at most one concurrent callback per
 * token ever reaches finalizeWhatsAppEmbeddedSignupForHotel(). On any
 * failure downstream (Meta cancellation/error, crypto failure, RPC 0026
 * failure) the lease is released so the visitor can retry with the SAME
 * link — the token is marked `used_at` ONLY after a genuine, complete
 * success.
 */
export async function receiveWhatsAppEmbeddedSignupCodeFromActivation(
  activationToken: string,
  code: string,
  signupResult: EmbeddedSignupResultHints
): Promise<ActionResult<EmbeddedSignupReceipt>> {
  const claim = await claimActivationToken(activationToken);
  if (!claim.ok) {
    return { ok: false, error: GENERIC_ACTIVATION_CLAIM_ERROR };
  }

  const result = await finalizeWhatsAppEmbeddedSignupForHotel(claim.data.hotelId, code, signupResult);

  if (!result.ok) {
    await releaseActivationTokenLease(claim.data.tokenId);
    return result;
  }

  const marked = await markActivationTokenUsed(claim.data.tokenId);
  if (!marked) {
    // The connection itself is already committed at this point (result.ok
    // is true) — failing to flip used_at is a data-hygiene concern, never a
    // reason to report failure for a connection that genuinely succeeded.
    console.error("receiveWhatsAppEmbeddedSignupCodeFromActivation: connection succeeded but the activation token could not be marked used", {
      hotelId: claim.data.hotelId,
    });
  }

  return result;
}
