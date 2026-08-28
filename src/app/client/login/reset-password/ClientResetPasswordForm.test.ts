import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ClientResetPasswordForm.tsx"), "utf8");

/**
 * Regression guards for the client-portal mirror of ResetPasswordForm.tsx —
 * same PKCE/implicit-grant session-establishment logic (see that file's own
 * ResetPasswordForm.test.ts for the shared reasoning, not repeated here),
 * checked here for the two things that must differ: the cookie scope used
 * and the post-success redirect target. Source-level, same DOM-less
 * constraint (no jsdom) as elsewhere in this repo.
 */
describe("ClientResetPasswordForm — client-portal cookie scope, not back-office", () => {
  it("[browser client] uses createClientPortalBrowserClient, never the plain createClient from lib/supabase/client", () => {
    expect(source).toMatch(/import \{ createClientPortalBrowserClient \} from "@\/lib\/supabase\/client";/);
    expect(source).toMatch(/createClientPortalBrowserClient\(\{ auth: \{ detectSessionInUrl: false \} \}\)/);
    expect(source).not.toMatch(/\bcreateClient\(/); // no bare createClient(...) call anywhere — only the Portal variant
  });

  it("[server action] calls updateClientPassword, never updatePassword", () => {
    expect(source).toMatch(/import \{ updateClientPassword, type UpdatePasswordState \} from "@\/features\/auth\/actions";/);
    expect(source).toMatch(/useActionState\(updateClientPassword, initialState\)/);
  });

  it("[redirect target] pushes to /client/dashboard on success, never /dashboard", () => {
    expect(source).toMatch(/router\.push\("\/client\/dashboard"\)/);
  });

  it("[forgot-password link] points to the client-scoped forgot-password page", () => {
    expect(source).toMatch(/href="\/client\/login\/forgot-password"/);
  });

  it("[same session-establishment shape as the back-office form] hash tokens via setSession, token_hash via verifyOtp, both SIGNED_IN/PASSWORD_RECOVERY accepted", () => {
    expect(source).toMatch(/supabase\.auth\.setSession\(\{ access_token: tokens\.accessToken, refresh_token: tokens\.refreshToken \}\)/);
    expect(source).toMatch(/supabase\.auth\.verifyOtp\(\{ token_hash: tokens\.tokenHash, type: tokens\.type \}\)/);
    expect(source).toMatch(/event === "PASSWORD_RECOVERY" \|\| event === "SIGNED_IN"/);
  });
});
