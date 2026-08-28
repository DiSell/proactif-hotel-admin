import { ClientForgotPasswordForm } from "./ClientForgotPasswordForm";

export default function ClientForgotPasswordPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-accent" />
          <span className="text-sm font-semibold text-ink">Proactif System</span>
        </div>
        <h1 className="mb-1 text-xl font-semibold text-ink">Mot de passe oublié</h1>
        <p className="mb-6 text-xs text-body">Recevez un email pour réinitialiser votre mot de passe.</p>
        <ClientForgotPasswordForm />
      </div>
    </div>
  );
}
