"use client";

import { useActionState } from "react";
import { updateClientPassword, type UpdatePasswordState } from "./actions";
import { FormField } from "@/components/ui/FormField";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";

const initialState: UpdatePasswordState = { error: null, success: false };

/**
 * Uses updateClientPassword() (features/auth/actions.ts) — the client-
 * portal-scoped counterpart of updatePassword(), required here because this
 * form is reached from an already-normal CLIENT-PORTAL session on
 * /client/account (lib/supabase/cookieScope.ts's client cookie); the
 * back-office updatePassword() would find no session at all under that
 * scope. It never redirects itself — unlike ClientResetPasswordForm.tsx
 * (which sends a fresh/activating session to /client/dashboard), success
 * here just shows a confirmation message in place, no navigation.
 */
export function ChangePasswordForm() {
  const [state, formAction, isPending] = useActionState(updateClientPassword, initialState);

  if (state.success) {
    return <p className="text-xs text-body">Mot de passe mis à jour.</p>;
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label="Nouveau mot de passe" htmlFor="account_password" required>
        <PasswordInput id="account_password" name="password" required autoComplete="new-password" minLength={8} />
      </FormField>
      <FormField label="Confirmer le mot de passe" htmlFor="account_confirm_password" required>
        <PasswordInput id="account_confirm_password" name="confirmPassword" required autoComplete="new-password" minLength={8} />
      </FormField>
      {state.error && (
        <p role="alert" className="text-2xs text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" variant="primary" className="w-fit" disabled={isPending}>
        {isPending ? "Mise à jour…" : "Changer le mot de passe"}
      </Button>
    </form>
  );
}
