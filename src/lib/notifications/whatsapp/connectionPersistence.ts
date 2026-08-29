import { createAdminClient } from "@/lib/supabase/admin";
import type { HotelWhatsAppConnectionType } from "@/features/whatsappIntegration/types";

/**
 * The ONLY place in this codebase allowed to call
 * public.finalize_hotel_whatsapp_connection_with_secret() (0026) — never
 * the historical public.finalize_hotel_whatsapp_connection() (0025)
 * directly, which service_role itself can no longer execute since 0026's
 * own hardening (see that migration's own header comment). Uses the
 * EXISTING service-role client (src/lib/supabase/admin.ts) — no new
 * Supabase key, no new admin mechanism.
 *
 * Receives ONLY already-encrypted crypto material
 * (connectionSecretCrypto.ts's own EncryptedWhatsAppConnectionSecret shape)
 * plus already-Meta-verified metadata — never a plaintext token, an
 * authorization code, or an app secret. Returns ONLY the non-secret
 * connection metadata this task's own minimization principle allows back
 * to a browser: never wabaId/phoneNumberId/businessId (not needed by any
 * current UI), never any crypto material.
 */

export type PersistWhatsAppConnectionErrorCode = "whatsapp_connection_persistence_failed";

export interface PersistWhatsAppConnectionInput {
  hotelId: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
  connectionType: HotelWhatsAppConnectionType;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string;
  encryptionVersion: number;
}

export interface PersistedWhatsAppConnection {
  connectionType: HotelWhatsAppConnectionType;
  connectedAt: string;
}

export type PersistWhatsAppConnectionResult =
  | { ok: true; data: PersistedWhatsAppConnection }
  | { ok: false; errorCode: PersistWhatsAppConnectionErrorCode };

/**
 * PostgreSQL's own well-documented hex representation for a bytea literal
 * passed through a text/JSON channel (`\x` followed by hex digits) — this
 * is the standard, universally-supported bytea input format regardless of
 * the server's own `bytea_output` setting (which only affects how bytea is
 * rendered back OUT, never how it's parsed IN). PostgREST/supabase-js send
 * RPC parameters as JSON; a JSON string value for a `bytea`-typed function
 * parameter is cast via an implicit `::bytea`, which recognizes this exact
 * format. NOT empirically re-verified against a live Supabase project in
 * this task (no live Meta/DB call is made anywhere in this codebase) — if
 * a real end-to-end run ever surfaces a casting error here, re-check this
 * function first before assuming the RPC itself is wrong.
 */
export function toPostgresByteaHex(buffer: Buffer): string {
  return `\\x${buffer.toString("hex")}`;
}

export async function persistWhatsAppConnection(input: PersistWhatsAppConnectionInput): Promise<PersistWhatsAppConnectionResult> {
  const supabase = createAdminClient();

  const { data, error } = await supabase.rpc("finalize_hotel_whatsapp_connection_with_secret", {
    p_hotel_id: input.hotelId,
    p_waba_id: input.wabaId,
    p_phone_number_id: input.phoneNumberId,
    p_business_id: input.businessId,
    p_connection_type: input.connectionType,
    p_ciphertext: toPostgresByteaHex(input.ciphertext),
    p_nonce: toPostgresByteaHex(input.nonce),
    p_auth_tag: toPostgresByteaHex(input.authTag),
    p_key_id: input.keyId,
    p_encryption_version: input.encryptionVersion,
    // Task section 7: the business token's real expiration is not
    // confirmed by Meta's own documentation — never fabricated here.
    p_expires_at: null,
  });

  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) {
    // Deliberately generic — never the RPC's own error message (which
    // could theoretically echo back a parameter), never any crypto
    // material, never the caller's own hotelId/waba/phone identifiers.
    console.error("persistWhatsAppConnection: RPC failed", { errorCode: error?.code ?? "no_row_returned" });
    return { ok: false, errorCode: "whatsapp_connection_persistence_failed" };
  }

  return {
    ok: true,
    data: {
      connectionType: row.connection_type as HotelWhatsAppConnectionType,
      connectedAt: row.connected_at as string,
    },
  };
}
