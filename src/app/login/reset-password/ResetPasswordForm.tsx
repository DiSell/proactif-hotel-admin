"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { updatePassword, type UpdatePasswordState } from "@/features/auth/actions";
import { FormField } from "@/components/ui/FormField";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";

const initialState: UpdatePasswordState = { error: null, success: false };

type SessionState = "checking" | "ready" | "invalid";

// How long to wait for the browser client to establish the recovery
// session from the emailed link's URL fragment before concluding the link
// is invalid/expired — detectSessionInUrl runs asynchronously on mount, but
// normally resolves near-instantly; this is a defensive ceiling, not an
// expected wait.
const SESSION_CHECK_TIMEOUT_MS = 3000;

/**
 * The recovery/invite session is established client-side from the URL the
 * email links to, but NOT via createBrowserClient's automatic
 * detectSessionInUrl handling — that's disabled below and the tokens are
 * parsed and applied manually. Reason: both inviteHotelClient
 * (features/hotelUsers/actions.ts) and requestPasswordReset
 * (features/auth/actions.ts) call Supabase's admin/server-side APIs
 * (inviteUserByEmail / resetPasswordForEmail), which run with no browser
 * involved and therefore never generate a PKCE code_verifier — GoTrue can
 * only redirect such links in the classic IMPLICIT format
 * (`#access_token=...&refresh_token=...&type=invite|recovery`, or, if this
 * project's mail templates were customized to the newer format,
 * `?token_hash=...&type=...`). @supabase/ssr's createBrowserClient
 * unconditionally hardcodes `flowType: "pkce"` (confirmed in its own
 * source — the literal is placed AFTER spreading caller options, so it
 * can't be overridden through the public API), and auth-js's own
 * _getSessionFromURL throws `AuthPKCEGrantCodeExchangeError('Not a valid
 * PKCE flow url.')` the instant it sees an implicit-format callback under a
 * PKCE-flow client. Left to its own automatic handling, this silently
 * fails: getSession() resolves with session: null, no SIGNED_IN/
 * PASSWORD_RECOVERY event ever fires, and every invite/reset link in this
 * app dead-ends on "Ce lien est invalide ou a expiré" — regardless of
 * whether the link is actually fresh and valid.
 *
 * The fix: detectSessionInUrl: false (still respected by createBrowserClient
 * even though flowType isn't), then handle both possible link shapes
 * ourselves — setSession() for the hash-based tokens, verifyOtp() for the
 * token_hash query-param format — using the SAME browser client instance,
 * so the resulting session still lands in @supabase/ssr's own cookie
 * storage exactly as detectSessionInUrl would have written it. That's what
 * makes it visible to updatePassword (a Server Action, features/auth/actions.ts)
 * afterwards: that action needs its own session-bound client because
 * updateUser operates on "the currently authenticated user", and that
 * session lives in the same cookies createClient() (server.ts) reads.
 *
 * This same page also serves first-time account activation after a client
 * invitation (see features/hotelUsers/actions.ts's inviteHotelClient) — an
 * invite link's session fires `SIGNED_IN`, a recovery link's fires
 * `PASSWORD_RECOVERY` (or, via the manual setSession() path here, always
 * `SIGNED_IN`); the listener below already accepts both, so no separate
 * activation route exists or is needed.
 */
function extractSessionTokensFromUrl(): { accessToken: string; refreshToken: string } | { tokenHash: string; type: "invite" | "recovery" } | null {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const accessToken = hashParams.get("access_token");
  const refreshToken = hashParams.get("refresh_token");
  if (accessToken && refreshToken) return { accessToken, refreshToken };

  const searchParams = new URLSearchParams(window.location.search);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  if (tokenHash && (type === "invite" || type === "recovery")) return { tokenHash, type };

  return null;
}

export function ResetPasswordForm() {
  const router = useRouter();
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [state, formAction, isPending] = useActionState(updatePassword, initialState);

  useEffect(() => {
    if (!state.success) return;
    // /dashboard bounces a non-superadmin straight to /client/dashboard
    // (see requireSuperadmin()'s doc comment) — this one redirect target
    // correctly serves both a superadmin's password recovery and a fresh
    // client's post-invite activation, with no role-aware logic here.
    router.push("/dashboard");
  }, [state.success, router]);

  useEffect(() => {
    // detectSessionInUrl: false — the automatic path can't consume this
    // link's implicit-grant format under @supabase/ssr's hardcoded PKCE
    // flowType (see the doc comment above); tokens are read and applied
    // manually below instead.
    const supabase = createClient({ auth: { detectSessionInUrl: false } });
    let settled = false;

    function markReady() {
      if (settled) return;
      settled = true;
      setSessionState("ready");
    }

    function markInvalid() {
      if (settled) return;
      settled = true;
      setSessionState("invalid");
    }

    (async () => {
      const tokens = extractSessionTokensFromUrl();
      if (!tokens) return; // no recognizable token in the URL — fall through to the getSession()/timeout safety net below (e.g. a reload after the session was already established and the URL already cleaned)

      const { error } =
        "accessToken" in tokens
          ? await supabase.auth.setSession({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken })
          : await supabase.auth.verifyOtp({ token_hash: tokens.tokenHash, type: tokens.type });

      // Strips the token(s) — hash fragment or query string — from the
      // visible URL/history either way, success or failure: a used or
      // invalid one-time token has no reason to linger there.
      window.history.replaceState(null, "", window.location.pathname);

      if (error) {
        console.error("ResetPasswordForm: session establishment failed", { message: error.message });
        markInvalid();
        return;
      }
      markReady();
    })();

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) markReady();
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") markReady();
    });

    const timeoutId = window.setTimeout(markInvalid, SESSION_CHECK_TIMEOUT_MS);

    return () => {
      listener.subscription.unsubscribe();
      window.clearTimeout(timeoutId);
    };
  }, []);

  if (sessionState === "checking") {
    return <p className="text-xs text-body">Vérification du lien…</p>;
  }

  if (sessionState === "invalid") {
    return (
      <div className="flex flex-col gap-4">
        <p role="alert" className="text-2xs text-danger">
          Ce lien de réinitialisation est invalide ou a expiré.
        </p>
        <Button href="/login/forgot-password" variant="secondary" className="w-full">
          Redemander un lien
        </Button>
      </div>
    );
  }

  if (state.success) {
    return <p className="text-xs text-body">Mot de passe mis à jour — redirection…</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label="Nouveau mot de passe" htmlFor="password" required>
        <PasswordInput id="password" name="password" required autoComplete="new-password" minLength={8} />
      </FormField>
      <FormField label="Confirmer le mot de passe" htmlFor="confirmPassword" required>
        <PasswordInput id="confirmPassword" name="confirmPassword" required autoComplete="new-password" minLength={8} />
      </FormField>
      {state.error && (
        <p role="alert" className="text-2xs text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" variant="primary" className="mt-2 w-full" disabled={isPending}>
        {isPending ? "Mise à jour…" : "Mettre à jour le mot de passe"}
      </Button>
    </form>
  );
}
