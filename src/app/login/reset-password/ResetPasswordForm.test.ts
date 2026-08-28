import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ResetPasswordForm.tsx"), "utf8");

/**
 * Regression guards for the invite/recovery session-establishment fix — a
 * "use client" component, same DOM-less testing constraint as elsewhere in
 * this repo (no jsdom) — checked at the source level.
 *
 * Root cause this guards against: @supabase/ssr's createBrowserClient
 * hardcodes flowType: "pkce" (confirmed in its own installed source,
 * node_modules/@supabase/ssr/dist/main/createBrowserClient.js), which makes
 * its automatic detectSessionInUrl handling throw
 * AuthPKCEGrantCodeExchangeError on the classic IMPLICIT-format callback
 * URL that an admin-initiated invite (inviteHotelClient) or a
 * resetPasswordForEmail link always produces (neither ever runs through a
 * browser, so no PKCE code_verifier can exist for either). Silently
 * failing this way meant every invite/reset link dead-ended on "lien
 * invalide" without ever reaching the client portal.
 */
describe("ResetPasswordForm — session establishment", () => {
  it("[auto URL detection disabled] createClient is called with detectSessionInUrl: false — the PKCE-locked automatic path is never relied on", () => {
    expect(source).toMatch(/createClient\(\{ auth: \{ detectSessionInUrl: false \} \}\)/);
  });

  it("[hash-based tokens handled] the classic implicit-grant format (#access_token=...&refresh_token=...) is parsed and applied via setSession", () => {
    expect(source).toMatch(/access_token/);
    expect(source).toMatch(/refresh_token/);
    expect(source).toMatch(/supabase\.auth\.setSession\(\{ access_token: tokens\.accessToken, refresh_token: tokens\.refreshToken \}\)/);
  });

  it("[token_hash query-param format also handled] the newer email-template format is parsed and applied via verifyOtp, not left unhandled", () => {
    expect(source).toMatch(/token_hash/);
    expect(source).toMatch(/supabase\.auth\.verifyOtp\(\{ token_hash: tokens\.tokenHash, type: tokens\.type \}\)/);
  });

  it("[both roles/link kinds accepted] the ready-state listener still accepts both SIGNED_IN (invite) and PASSWORD_RECOVERY (recovery)", () => {
    expect(source).toMatch(/event === "PASSWORD_RECOVERY" \|\| event === "SIGNED_IN"/);
  });

  it("[url cleanup] the token is stripped from the visible URL after being consumed, success or failure", () => {
    expect(source).toMatch(/window\.history\.replaceState\(null, "", window\.location\.pathname\)/);
  });

  it("[timeout safety net preserved] a link with no recognizable token still eventually resolves to invalid, never hangs forever", () => {
    expect(source).toMatch(/window\.setTimeout\(markInvalid, SESSION_CHECK_TIMEOUT_MS\)/);
  });
});
