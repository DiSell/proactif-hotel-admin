// Public, unauthenticated activation page — the hotel's own WhatsApp
// Business owner has no account in this app at all, so there's no login
// here (same posture as src/app/partenaires/consentement/page.tsx). The
// activation token itself is the sole authorization; this page performs a
// read-only, non-mutating check (peekActivationTokenStatus) purely to
// decide what to render — the REAL, atomic claim of the token happens
// later, server-side, inside receiveWhatsAppEmbeddedSignupCodeFromActivation
// (actions.ts), only once the visitor actually completes Meta's popup.
//
// This route is added to PUBLIC_PATHS in src/lib/supabase/updateSession.ts
// — without that, the auth middleware would redirect an anonymous visitor
// to /login before this page ever rendered.
import { peekActivationTokenStatus } from "@/features/whatsappIntegration/activationTokenPersistence";
import { EmbeddedSignupButton } from "@/features/whatsappIntegration/EmbeddedSignupButton";
import { ToastProvider } from "@/components/ui/Toast";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-accent" />
          <span className="text-sm font-semibold text-ink">Proactif System</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function InvalidLink() {
  return (
    <Card>
      <h1 className="mb-2 text-lg font-semibold text-ink">Lien invalide</h1>
      <p className="text-xs text-body">Ce lien n&rsquo;est plus valide.</p>
    </Card>
  );
}

export default async function WhatsAppActivationPage({ params }: PageProps<"/whatsapp/connect/[token]">) {
  const { token } = await params;
  const status = await peekActivationTokenStatus(token);
  if (status === "invalid") return <InvalidLink />;

  return (
    <Card>
      <h1 className="mb-2 text-lg font-semibold text-ink">Connecter WhatsApp Business</h1>
      <p className="mb-6 text-xs text-body">Cette connexion permet à votre établissement d&rsquo;utiliser WhatsApp avec Proactif System.</p>
      <ToastProvider>
        <EmbeddedSignupButton activationToken={token} />
      </ToastProvider>
    </Card>
  );
}
