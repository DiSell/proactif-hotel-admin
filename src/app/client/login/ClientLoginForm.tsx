"use client";

import { useActionState } from "react";
import Link from "next/link";
import { clientLogin, type LoginState } from "@/features/auth/actions";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { PasswordInput } from "@/components/ui/PasswordInput";
import { Button } from "@/components/ui/Button";

const initialState: LoginState = { error: null };

/**
 * Mirrors LoginForm.tsx (back-office) exactly, but calls clientLogin() —
 * writes ONLY the client-portal session cookie (lib/supabase/cookieScope.ts).
 * A superadmin account is rejected here (clientLogin's own doc comment) —
 * use /login instead.
 */
export function ClientLoginForm() {
  const [state, formAction, isPending] = useActionState(clientLogin, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label="Email" htmlFor="email" required>
        <input id="email" name="email" type="email" required autoComplete="email" className={inputClassName()} />
      </FormField>
      <FormField label="Mot de passe" htmlFor="password" required>
        <PasswordInput id="password" name="password" required autoComplete="current-password" />
      </FormField>
      {state.error && (
        <p role="alert" className="text-2xs text-danger">
          {state.error}
        </p>
      )}
      <Link href="/client/login/forgot-password" className="text-2xs text-body hover:text-ink">
        Mot de passe oublié ?
      </Link>
      <Button type="submit" variant="primary" className="mt-2 w-full" disabled={isPending}>
        {isPending ? "Connexion…" : "Se connecter"}
      </Button>
    </form>
  );
}
