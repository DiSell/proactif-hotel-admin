/**
 * Meta WhatsApp Embedded Signup — shapes confirmed against Meta's own
 * current documentation during this task's audit (developers.facebook.com/
 * documentation/business-messaging/whatsapp/embedded-signup/implementation,
 * checked 2026-08-29). Embedded Signup v2 is documented as deprecated
 * 2026-10-15 — everything here targets the CURRENT (v4-era) flow, never a
 * copy-pasted v2 snippet found elsewhere online.
 *
 * NOTHING in this module ever calls Meta for real, stores a token, or
 * persists a WABA/phone number id — see actions.ts's own doc comment on
 * why (pending a validated DB design, task's own explicit STOP condition).
 */

/**
 * The exact `event` values Meta's postMessage can carry — confirmed by
 * documentation. FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING is the
 * "coexistence" path (the existing WhatsApp Business App number keeps
 * working on the phone AND becomes usable via the Cloud API) — the ONLY
 * outcome this codebase currently treats as safe to continue past.
 * FINISH_OBO_MIGRATION's exact effect on the partner's existing app/number
 * could NOT be confirmed as non-destructive from available documentation —
 * deliberately treated as a case requiring an explicit stop and a clear
 * message, never silently continued (see EmbeddedSignupButton.tsx's own
 * doc comment and the task's own "no destructive migration" requirement).
 */
export type EmbeddedSignupFinishEvent =
  | "FINISH"
  | "FINISH_ONLY_WABA"
  | "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
  | "FINISH_OBO_MIGRATION"
  | "FINISH_GRANT_ONLY_API_ACCESS";

export interface EmbeddedSignupFinishData {
  event: EmbeddedSignupFinishEvent;
  wabaId: string | null;
  phoneNumberId: string | null;
  businessId: string | null;
}

export interface EmbeddedSignupCancelData {
  event: "CANCEL";
  currentStep: string | null;
}

export interface EmbeddedSignupErrorData {
  event: "ERROR";
}

/**
 * The parsed, TRUSTED-STRUCTURE result of one postMessage event — "trusted
 * structure" meaning the shape/origin were validated, NOT that the
 * ids/waba/phone number inside are trusted for any server-side mutation.
 * They are display-only until a real server-side Meta exchange confirms
 * them independently (never implemented in this task — see actions.ts).
 */
export type EmbeddedSignupMessage = EmbeddedSignupFinishData | EmbeddedSignupCancelData | EmbeddedSignupErrorData;

/**
 * The button's own UI state machine. `"connected"` is reachable ONLY after
 * receiveWhatsAppEmbeddedSignupCode() (actions.ts) returns a genuine
 * success — meaning the server independently re-verified the WABA/
 * phone_number_id/app subscription against Meta, encrypted the business
 * token, AND finalize_hotel_whatsapp_connection_with_secret() (0026)
 * committed both the connection and its secret atomically. Never set from
 * the browser's own postMessage/FB.login response alone.
 */
export type EmbeddedSignupStatus =
  | "not_connected"
  | "loading_sdk"
  | "opening"
  | "connected"
  | "cancelled"
  | "unsupported_flow"
  | "error";

/**
 * Row shape of public.hotel_whatsapp_connections
 * (0024_hotel_whatsapp_connections.sql) — colocated here rather than in
 * src/types/database.ts, same precedent as
 * features/partnerRequests/types.ts's own PartnerRequest/
 * PartnerRequestDelivery: this table is scoped entirely to one feature,
 * unlike Hotel/HotelPartner which are shared much more broadly.
 *
 * Deliberately declares NO token/credential field, ever — the table itself
 * has none (0024's own "no secret columns" guarantee); the system-user
 * token that eventually sends messages stays the existing SERVER-GLOBAL
 * WHATSAPP_META_ACCESS_TOKEN (src/lib/notifications/whatsapp/), never a
 * per-connection value.
 *
 * `status: "active"` on a row read here is NEVER, by itself, proof that
 * messages can actually be sent through it — see the migration's own
 * header comment on why only an independent server-side validation
 * (not yet implemented) may ever set this value.
 */
export type HotelWhatsAppConnectionType = "coexistence" | "cloud_api_only";
export type HotelWhatsAppConnectionStatus = "pending" | "active" | "revoked" | "error";

export interface HotelWhatsAppConnection {
  id: string;
  hotel_id: string;
  waba_id: string;
  phone_number_id: string;
  business_id: string | null;
  connection_type: HotelWhatsAppConnectionType;
  status: HotelWhatsAppConnectionStatus;
  is_primary: boolean;
  connected_at: string | null;
  disconnected_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}
