"use client";

import { useActionState } from "react";
import { requestClientPasswordReset, type RequestPasswordResetState } from "@/features/auth/actions";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";

const initialState: RequestPasswordResetState = { error: null, sent: false };

/**
 * Mirrors ForgotPasswordForm.tsx (back-office) exactly, but calls
 * requestClientPasswordReset() — the emailed link points to
 * /client/login/reset-password (client-portal cookie scope). state.sent is
 * shown regardless of whether the email actually matched an account — same
 * anti-enumeration discipline as the back-office form.
 */
export function ClientForgotPasswordForm() {
  const [state, formAction, isPending] = useActionState(requestClientPasswordReset, initialState);

  if (state.sent) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-xs text-body">
          Si un compte existe pour cet email, un lien de réinitialisation vient d&rsquo;être envoyé. Vérifiez votre boîte de réception (et vos
          spams).
        </p>
        <Button href="/client/login" variant="secondary" className="w-full">
          Retour à la connexion
        </Button>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label="Email" htmlFor="email" required>
        <input id="email" name="email" type="email" required autoComplete="email" className={inputClassName()} />
      </FormField>
      {state.error && (
        <p role="alert" className="text-2xs text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" variant="primary" className="mt-2 w-full" disabled={isPending}>
        {isPending ? "Envoi…" : "Envoyer le lien"}
      </Button>
      <Button href="/client/login" variant="ghost" className="w-full">
        Retour à la connexion
      </Button>
    </form>
  );
}
