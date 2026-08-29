// Meta WhatsApp Embedded Signup — server-side finalization chain
// (task: "IMPLÉMENTER LA FINALISATION SERVEUR DE META WHATSAPP EMBEDDED
// SIGNUP"). Deliberately SEPARATE from metaProvider.ts (task section 6):
// metaProvider.ts is the send/receive transport for an ALREADY-connected
// number; this file is the one-time onboarding chain that produces that
// connection in the first place. Mixing the two would make it easy to
// accidentally gate a send-path change behind onboarding-only config, or
// vice versa.
//
// CONFIRMATION STATUS PER STEP (checked live against developers.facebook.com
// during this task — never from training-data memory alone, per the task's
// own "ne pas l'inventer" requirement):
//
//   - getPhoneNumber's status fields (is_on_biz_app/platform_type) and the
//     GET /{PHONE_NUMBER_ID}?fields=... shape: CONFIRMED via a live fetch of
//     developers.facebook.com/documentation/business-messaging/whatsapp/
//     embedded-signup/onboarding-business-app-users/ (2026-08-29).
//   - subscribeAppToWaba's POST /{WABA_ID}/subscribed_apps: CONFIRMED via a
//     live search surfacing Meta's own reference page
//     "WhatsApp Business Account - Subscribed Apps API"
//     (developers.facebook.com/documentation/business-messaging/whatsapp/
//     reference/whatsapp-business-account/subscribed-apps-api) (2026-08-29).
//   - getWhatsAppBusinessAccount's GET /{WABA_ID}?fields=id and the
//     GET /{WABA_ID}/phone_numbers listing used to confirm a phone number
//     genuinely belongs to that WABA: standard, widely-documented Graph API
//     object/edge reads for a WhatsApp Business Account — NOT independently
//     re-fetched from a live Meta page in this session (the docs site's
//     Business Management API reference did not return readable content to
//     this session's fetch tool). Treated as high-confidence but not
//     "freshly confirmed" in the same sense as the two items above.
//   - exchangeEmbeddedSignupCode's endpoint: CONFIRMED (re-audited and
//     corrected — a prior version of this comment/implementation had used
//     the generic redirect-based OAuth pattern as an unconfirmed guess,
//     which violated this codebase's own "never invent an unconfirmed
//     indispensable step" rule; this is the fix). Meta's own Embedded
//     Signup implementation page still defers the exchange step to a
//     "Tech Provider"/"Solution Partner" onboarding page this session's
//     fetch tool could not render — but Embedded Signup's own FB.login()
//     call in this codebase (config_id + response_type: "code" +
//     override_default_response_type: true, see EmbeddedSignupButton.tsx)
//     is BYTE-FOR-BYTE the "Facebook Login for Business" config_id flow
//     documented at developers.facebook.com/documentation/facebook-login/
//     facebook-login-for-business (fetched live 2026-08-29, quoted
//     verbatim across two independent fetches of the same page): "You must
//     then exchange this code for an access token by performing a
//     server-to-server call to our servers" — with the ONLY example shown
//     for this exact config_id/response_type=code flow being
//     `GET https://graph.facebook.com/v25.0/oauth/access_token?
//     client_id=<APP_ID>&client_secret=<APP_SECRET>&code=<CODE>` —
//     THREE parameters only, no redirect_uri (redirect_uri belongs to a
//     DIFFERENT, classic browser-redirect OAuth flow the same page also
//     documents elsewhere; it has no meaning for a JS-SDK popup flow with
//     no redirect at all). This matches the implementation below exactly.
//
//     OPEN QUESTION NOT COVERED BY THIS CONFIRMATION, deliberately NOT
//     acted on here per this task's own "n'implémente que l'échange du
//     code" scope: the same official page also documents a SEPARATE
//     "business integration system user access token" mechanism
//     (POST /{business-id}/system_user_access_tokens, returning a
//     never-expiring token) for Tech Provider server-to-server use. Whether
//     the plain access_token returned by the /oauth/access_token exchange
//     above is directly sufficient for the WABA/phone_number/subscription
//     calls below, or whether a Tech Provider must additionally convert it
//     via that separate endpoint first, was NOT confirmed this session. No
//     code below assumes an answer either way — every downstream call
//     already treats a non-2xx/mismatched response as a hard failure
//     (never a false "active"), so an insufficient token here fails safely
//     into waba_verification_failed rather than a false positive. Re-verify
//     against Meta's real Tech Provider docs (or a real test-mode exchange)
//     before relying on this exchange for anything beyond the mocked tests
//     in this file.
//   - Phone number registration (POST /{phone-number-id}/register) for a
//     brand-new, non-coexistence number: NOT CONFIRMED this session either
//     (same gap already flagged in this feature's own prior task) —
//     deliberately NOT implemented here. See finalizeEmbeddedSignup's own
//     doc comment on why this narrows `connection_type: "coexistence"` to
//     the only finish event this file can currently finalize end-to-end.
//
// NOTHING in this file is ever invoked against the real network in this
// codebase — every test mocks fetch. No secret, token, or authorization
// code is ever logged (only HTTP status codes and closed error codes).
import type { EmbeddedSignupFinishEvent } from "@/features/whatsappIntegration/types";

export interface MetaEmbeddedSignupConfig {
  appId: string;
  appSecret: string;
  apiVersion: string;
}

/**
 * Independent of readMetaConfigFromEnv() (metaProvider.ts) on purpose (task
 * section 7): onboarding needs only the APP's own id/secret/version, never
 * the send-side WHATSAPP_META_ACCESS_TOKEN/PHONE_NUMBER_ID/VERIFY_TOKEN —
 * requiring those here would make finalization depend on a number already
 * being fully configured for sending, which is backwards. Reuses
 * NEXT_PUBLIC_META_APP_ID (legitimately public, task section 3 of the prior
 * task) — a server reading its own public env var is fine; the point of
 * NEXT_PUBLIC_ is what the BROWSER may see, not a restriction on server
 * reads.
 */
export function readMetaEmbeddedSignupConfigFromEnv(): MetaEmbeddedSignupConfig | null {
  const appId = process.env.NEXT_PUBLIC_META_APP_ID;
  const appSecret = process.env.WHATSAPP_META_APP_SECRET;
  const apiVersion = process.env.WHATSAPP_META_API_VERSION;
  if (!appId?.trim() || !appSecret?.trim() || !apiVersion?.trim()) return null;
  return { appId, appSecret, apiVersion };
}

export type EmbeddedSignupErrorCode =
  | "config_missing"
  | "code_exchange_failed"
  | "waba_verification_failed"
  | "phone_number_verification_failed"
  | "phone_number_mismatch"
  | "subscription_failed"
  | "unsupported_finish_event";

interface ExchangeResult {
  /** Ephemeral. Never returned beyond this module's own orchestration, never logged, never persisted. */
  accessToken: string;
}

/**
 * CONFIRMED endpoint shape — see this file's own header comment (Meta's
 * "Facebook Login for Business" official docs, config_id/response_type=code
 * flow, fetched live). Never throws with response body content; only a
 * closed error code surfaces.
 */
export async function exchangeEmbeddedSignupCode(code: string, config: MetaEmbeddedSignupConfig): Promise<ExchangeResult | null> {
  try {
    const url = new URL(`https://graph.facebook.com/${config.apiVersion}/oauth/access_token`);
    url.searchParams.set("client_id", config.appId);
    url.searchParams.set("client_secret", config.appSecret);
    url.searchParams.set("code", code);

    const response = await fetch(url, { method: "GET" });
    const json = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
    const accessToken = json?.access_token;
    if (!response.ok || typeof accessToken !== "string" || !accessToken) {
      console.error("exchangeEmbeddedSignupCode: exchange failed", { status: response.status });
      return null;
    }
    return { accessToken };
  } catch {
    console.error("exchangeEmbeddedSignupCode: transport exception");
    return null;
  }
}

interface VerifiedWaba {
  wabaId: string;
}

/**
 * Proves Proactif's own system user/app genuinely has access to this WABA —
 * never trusts the raw waba_id from the browser's postMessage alone (task
 * section 9). A permission error or any non-2xx response here means "not
 * verifiably ours", never a best-effort pass-through.
 */
export async function getWhatsAppBusinessAccount(wabaId: string, accessToken: string, config: MetaEmbeddedSignupConfig): Promise<VerifiedWaba | null> {
  try {
    const url = new URL(`https://graph.facebook.com/${config.apiVersion}/${wabaId}`);
    url.searchParams.set("fields", "id");
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const json = (await response.json().catch(() => null)) as { id?: unknown } | null;
    if (!response.ok || typeof json?.id !== "string" || json.id !== wabaId) {
      console.error("getWhatsAppBusinessAccount: verification failed", { status: response.status });
      return null;
    }
    return { wabaId: json.id };
  } catch {
    console.error("getWhatsAppBusinessAccount: transport exception");
    return null;
  }
}

interface VerifiedPhoneNumber {
  phoneNumberId: string;
  isOnBizApp: boolean;
}

/**
 * Two independent checks (task section 10): (1) phoneNumberId genuinely
 * belongs to the ALREADY-validated wabaId — via the WABA's own
 * /phone_numbers edge, never assumed from the browser's claim; (2) the
 * number's own onboarding status via the confirmed
 * ?fields=is_on_biz_app,platform_type endpoint. A phone number that exists
 * but belongs to a DIFFERENT WABA returns null here — never silently
 * accepted (this is the concrete mechanism behind
 * finalizeEmbeddedSignup's "phone_number_mismatch" error).
 */
export async function getPhoneNumber(
  phoneNumberId: string,
  wabaId: string,
  accessToken: string,
  config: MetaEmbeddedSignupConfig
): Promise<VerifiedPhoneNumber | null> {
  try {
    const listUrl = new URL(`https://graph.facebook.com/${config.apiVersion}/${wabaId}/phone_numbers`);
    const listResponse = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const listJson = (await listResponse.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    if (!listResponse.ok || !Array.isArray(listJson?.data)) {
      console.error("getPhoneNumber: waba phone_numbers listing failed", { status: listResponse.status });
      return null;
    }
    const belongsToWaba = listJson.data.some((entry) => entry?.id === phoneNumberId);
    if (!belongsToWaba) {
      console.error("getPhoneNumber: phone_number_id does not belong to the verified waba");
      return null;
    }

    const statusUrl = new URL(`https://graph.facebook.com/${config.apiVersion}/${phoneNumberId}`);
    statusUrl.searchParams.set("fields", "is_on_biz_app,platform_type");
    const statusResponse = await fetch(statusUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    const statusJson = (await statusResponse.json().catch(() => null)) as { id?: unknown; is_on_biz_app?: unknown } | null;
    if (!statusResponse.ok || typeof statusJson?.id !== "string" || statusJson.id !== phoneNumberId) {
      console.error("getPhoneNumber: status lookup failed", { status: statusResponse.status });
      return null;
    }
    return { phoneNumberId, isOnBizApp: statusJson.is_on_biz_app === true };
  } catch {
    console.error("getPhoneNumber: transport exception");
    return null;
  }
}

/**
 * CONFIRMED endpoint (see file header). The connection must never become
 * active if this fails (task section 12) — a webhook is worthless if the
 * app was never actually subscribed to receive this WABA's events.
 */
export async function subscribeAppToWaba(wabaId: string, accessToken: string, config: MetaEmbeddedSignupConfig): Promise<boolean> {
  try {
    const url = `https://graph.facebook.com/${config.apiVersion}/${wabaId}/subscribed_apps`;
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${accessToken}` } });
    const json = (await response.json().catch(() => null)) as { success?: unknown } | null;
    if (!response.ok || json?.success !== true) {
      console.error("subscribeAppToWaba: subscription failed", { status: response.status });
      return false;
    }
    return true;
  } catch {
    console.error("subscribeAppToWaba: transport exception");
    return false;
  }
}

export interface FinalizeEmbeddedSignupParams {
  code: string;
  finishEvent: EmbeddedSignupFinishEvent;
  /** Browser-supplied hints — UNTRUSTED (task section 5) until independently re-verified against Meta below. */
  claimedWabaId: string | null;
  claimedPhoneNumberId: string | null;
  claimedBusinessId: string | null;
}

export type FinalizeEmbeddedSignupResult =
  | {
      ok: true;
      wabaId: string;
      phoneNumberId: string;
      businessId: string | null;
      connectionType: "coexistence";
    }
  | { ok: false; errorCode: EmbeddedSignupErrorCode };

/**
 * Orchestrates the full chain (task section 1's own trace, now implemented):
 * hotel (caller's own responsibility, never this function's) -> code ->
 * WABA -> phone_number_id -> app subscription -> a result the caller may
 * persist as `active`.
 *
 * DELIBERATELY narrowed to `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`
 * (coexistence) ONLY. Every other currently-UI-safe finish event (FINISH,
 * FINISH_ONLY_WABA, FINISH_GRANT_ONLY_API_ACCESS) returns
 * "unsupported_finish_event" here, NOT because the UI misclassified them as
 * safe-to-continue-past-cancel, but because finishing them for real would
 * require the phone-number REGISTRATION step
 * (POST /{phone-number-id}/register) — an endpoint this task's live
 * documentation audit could not confirm (see file header). Meta's own
 * coexistence docs are the ONE place that explicitly states registration is
 * unnecessary ("skip the phone number registration step, as the number is
 * already registered") — which is exactly why this is the only path that
 * can be finalized end-to-end without inventing an unconfirmed step.
 * FINISH_OBO_MIGRATION never reaches this function at all — the UI layer
 * (embeddedSignupMessage.ts::isSafeFinishEvent) already stops it earlier.
 */
export async function finalizeEmbeddedSignup(params: FinalizeEmbeddedSignupParams): Promise<FinalizeEmbeddedSignupResult> {
  const config = readMetaEmbeddedSignupConfigFromEnv();
  if (!config) return { ok: false, errorCode: "config_missing" };

  if (params.finishEvent !== "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING") {
    return { ok: false, errorCode: "unsupported_finish_event" };
  }
  if (!params.claimedWabaId || !params.claimedPhoneNumberId) {
    return { ok: false, errorCode: "waba_verification_failed" };
  }

  const exchange = await exchangeEmbeddedSignupCode(params.code, config);
  if (!exchange) return { ok: false, errorCode: "code_exchange_failed" };

  const waba = await getWhatsAppBusinessAccount(params.claimedWabaId, exchange.accessToken, config);
  if (!waba) return { ok: false, errorCode: "waba_verification_failed" };

  const phoneNumber = await getPhoneNumber(params.claimedPhoneNumberId, waba.wabaId, exchange.accessToken, config);
  if (!phoneNumber) return { ok: false, errorCode: "phone_number_mismatch" };

  const subscribed = await subscribeAppToWaba(waba.wabaId, exchange.accessToken, config);
  if (!subscribed) return { ok: false, errorCode: "subscription_failed" };

  return {
    ok: true,
    wabaId: waba.wabaId,
    phoneNumberId: phoneNumber.phoneNumberId,
    businessId: params.claimedBusinessId,
    connectionType: "coexistence",
  };
}
