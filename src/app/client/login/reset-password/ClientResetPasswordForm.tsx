"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClientPortalBrowserClient } from "@/lib/supabase/client";
import { updateClientPassword, type UpdatePasswordState } from "@/features/auth/actions";
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
 * Exact mirror of src/app/login/reset-password/ResetPasswordForm.tsx (see
 * that file's own extensive doc comment for the full PKCE/implicit-grant
 * reasoning — unchanged here), but bound to the CLIENT-PORTAL cookie scope
 * throughout: createClientPortalBrowserClient() (lib/supabase/client.ts)
 * instead of the default browser client, and updateClientPassword()
 * (features/auth/actions.ts) instead of updatePassword(). This is what
 * makes the resulting session land under sb-client-portal-auth-token
 * (lib/supabase/cookieScope.ts) rather than the back-office cookie —
 * required for both:
 *   - first-time hotel_admin activation (inviteHotelClient's redirectTo
 *     now points here, never /login/reset-password)
 *   - client-portal password recovery (requestClientPasswordReset)
 * Redirects to /client/dashboard on success, not /dashboard.
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

export function ClientResetPasswordForm() {
  const router = useRouter();
  const [sessionState, setSessionState] = useState<SessionState>("checking");
  const [state, formAction, isPending] = useActionState(updateClientPassword, initialState);

  useEffect(() => {
    if (!state.success) return;
    router.push("/client/dashboard");
  }, [state.success, router]);

  useEffect(() => {
    // detectSessionInUrl: false — the automatic path can't consume this
    // link's implicit-grant format under @supabase/ssr's hardcoded PKCE
    // flowType (see ResetPasswordForm.tsx's own doc comment); tokens are
    // read and applied manually below instead.
    const supabase = createClientPortalBrowserClient({ auth: { detectSessionInUrl: false } });
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
        console.error("ClientResetPasswordForm: session establishment failed", { message: error.message });
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
        <Button href="/client/login/forgot-password" variant="secondary" className="w-full">
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
