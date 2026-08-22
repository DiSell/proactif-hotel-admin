"use client";

import { useActionState } from "react";
import { login, type LoginState } from "@/features/auth/actions";
import { FormField, inputClassName } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";

const initialState: LoginState = { error: null };

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <FormField label="Email" htmlFor="email" required>
        <input id="email" name="email" type="email" required autoComplete="email" className={inputClassName()} />
      </FormField>
      <FormField label="Mot de passe" htmlFor="password" required>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={inputClassName()}
        />
      </FormField>
      {state.error && (
        <p role="alert" className="text-2xs text-danger">
          {state.error}
        </p>
      )}
      <Button type="submit" variant="primary" className="mt-2 w-full" disabled={isPending}>
        {isPending ? "Connexion…" : "Se connecter"}
      </Button>
    </form>
  );
}
