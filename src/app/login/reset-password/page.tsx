import { ResetPasswordForm } from "./ResetPasswordForm";

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-accent" />
          <span className="text-sm font-semibold text-ink">Proactif System</span>
        </div>
        <h1 className="mb-1 text-xl font-semibold text-ink">Nouveau mot de passe</h1>
        <p className="mb-6 text-xs text-body">Choisissez un nouveau mot de passe pour votre compte.</p>
        <ResetPasswordForm />
      </div>
    </div>
  );
}
