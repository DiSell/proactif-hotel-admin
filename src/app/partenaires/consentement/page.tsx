// Public, unauthenticated confirmation page — the partner has no account
// in this app, so there's no login here at all (see
// features/partners/consentLookup.ts's own doc comment). Reachable only
// via the one-time link sent by requestPartnerConsentBackoffice/Client
// (features/partners/actions.ts); the token itself is the sole
// authorization, exactly like a Supabase Auth magic link.
import { getPartnerConsentRequest } from "@/features/partners/consentLookup";
import { ConsentResponseButtons } from "./ConsentResponseButtons";

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

export default async function PartnerConsentPage({ searchParams }: PageProps<"/partenaires/consentement">) {
  const resolvedSearchParams = await searchParams;
  const rawToken = resolvedSearchParams?.token;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  const request = token ? await getPartnerConsentRequest(token) : null;

  if (!request) {
    return (
      <Card>
        <h1 className="mb-2 text-lg font-semibold text-ink">Lien invalide</h1>
        <p className="text-xs text-body">Ce lien de confirmation est invalide ou a expiré.</p>
      </Card>
    );
  }

  if (request.status !== "pending") {
    const message =
      request.status === "accepted"
        ? "Vous avez déjà accepté cette demande — merci."
        : request.status === "declined"
          ? "Vous avez déjà refusé cette demande."
          : "Cette demande n'est plus en attente de réponse.";
    return (
      <Card>
        <h1 className="mb-2 text-lg font-semibold text-ink">Déjà répondu</h1>
        <p className="text-xs text-body">{message}</p>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold text-ink">Demande de recommandation</h1>
      <p className="mb-6 text-xs text-body">
        L&rsquo;établissement <strong>{request.hotelName}</strong> souhaite recommander <strong>{request.partnerName}</strong> à ses visiteurs via
        son assistant virtuel. Acceptez-vous ?
      </p>
      <ConsentResponseButtons token={token as string} initialOpeningHours={request.openingHours} initialAddress={request.address} />
    </Card>
  );
}
