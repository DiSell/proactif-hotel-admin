"use server";

import { requireClientAccess } from "@/lib/auth/session";
import { finalizeEmbeddedSignup } from "@/lib/notifications/whatsapp/metaEmbeddedSignup";
import type { ActionResult } from "@/lib/actionResult";
import type { EmbeddedSignupFinishEvent } from "./types";

/**
 * Tenant is ALWAYS the caller's own session (requireClientAccess()) — never
 * a parameter. This function deliberately has no `hotelId` argument: a
 * browser can send whatever code/signupResult it wants, but it can never
 * target a different hotel's row (task section 4's own explicit forbidden
 * signature: `receiveWhatsAppEmbeddedSignupCode(hotelId, code)`).
 *
 * DELIBERATE STOP BOUNDARY (see this task's own final report, sections
 * 11/16): finalizeEmbeddedSignup() below performs a REAL server-side
 * verification chain against Meta (code exchange -> WABA ownership ->
 * phone_number_id membership -> app subscription) — but even a fully
 * successful result is NOT persisted here. 0024_hotel_whatsapp_connections.sql
 * revokes direct INSERT/UPDATE/DELETE from every role, including
 * service_role, and no SECURITY DEFINER finalization RPC exists yet — see
 * this task's own report for the proposed (not created)
 * 0025_hotel_whatsapp_connection_finalization.sql. Writing directly to the
 * table from here would mean inventing an unreviewed persistence path,
 * exactly what the task's own STOP condition forbids.
 */
export interface EmbeddedSignupReceipt {
  received: true;
  /**
   * true only when the server independently re-verified the WABA, the
   * phone_number_id, and the app's own subscription to that WABA against
   * Meta itself (metaEmbeddedSignup.ts::finalizeEmbeddedSignup) — NEVER
   * derived from the browser's own postMessage/FB.login response alone.
   * Deliberately never "connected" or "active": it means "Meta itself has
   * confirmed this hotel's connection is real", NOT "this connection is now
   * saved" — no caller may render this as "WhatsApp connecté".
   */
  finalized: boolean;
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

export async function receiveWhatsAppEmbeddedSignupCode({ code, signupResult }: EmbeddedSignupCodeInput): Promise<ActionResult<EmbeddedSignupReceipt>> {
  // hotelId is derived ENTIRELY from the authenticated client-portal
  // session (see requireClientAccess()'s own doc comment: it reads
  // hotel_users for the logged-in userId) — there is no parameter here a
  // browser could use to target a different hotel's connection.
  const { hotelId } = await requireClientAccess();

  if (typeof code !== "string" || !code.trim()) {
    return { ok: false, error: "Code d'autorisation Meta manquant." };
  }

  const result = await finalizeEmbeddedSignup({
    code,
    finishEvent: signupResult.event,
    claimedWabaId: signupResult.wabaId,
    claimedPhoneNumberId: signupResult.phoneNumberId,
    claimedBusinessId: signupResult.businessId,
  });

  if (!result.ok) {
    // Deliberately generic (task section 17) — never reveals which Graph
    // API step failed, never a response body, never the errorCode itself.
    console.info("receiveWhatsAppEmbeddedSignupCode: server-side finalization did not complete", { hotelId, errorCode: result.errorCode });
    return { ok: false, error: "La connexion WhatsApp n'a pas pu être finalisée." };
  }

  // Logs only non-sensitive, already-server-verified identifiers — never
  // the authorization code, never an access token.
  console.info("receiveWhatsAppEmbeddedSignupCode: finalization validated server-side against Meta, persistence pending a validated 0025 RPC", {
    hotelId,
    wabaId: result.wabaId,
    phoneNumberId: result.phoneNumberId,
  });

  return { ok: true, data: { received: true, finalized: true } };
}
