// Public, unauthenticated unsubscribe page — reachable only via the link
// embedded in a marketing email's footer (features/loyalty/worker.ts). The
// token itself is the sole authorization, exactly like the partner consent
// page (src/app/partenaires/consentement/page.tsx). One click unsubscribes
// immediately (no confirm step) — the standard, low-friction pattern
// expected of a marketing-email unsubscribe link.
import { unsubscribeCustomerByToken } from "@/features/loyalty/unsubscribeActions";

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

export default async function UnsubscribePage({ searchParams }: PageProps<"/desinscription">) {
  const resolvedSearchParams = await searchParams;
  const rawToken = resolvedSearchParams?.token;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  const result = token ? await unsubscribeCustomerByToken(token) : { ok: false as const };

  if (!result.ok) {
    return (
      <Card>
        <h1 className="mb-2 text-lg font-semibold text-ink">Lien invalide</h1>
        <p className="text-xs text-body">Ce lien de désinscription est invalide.</p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-2 text-lg font-semibold text-ink">Désinscription confirmée</h1>
      <p className="text-xs text-body">
        Vous ne recevrez plus de communications marketing de la part de <strong>{result.hotelName}</strong>.
      </p>
    </Card>
  );
}
