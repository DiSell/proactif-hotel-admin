// Public, unauthenticated confirmation page — the partner has no account
// in this app, so there's no login here at all (see
// features/partners/consentLookup.ts's own doc comment). Reachable only
// via the ONE-time link sent by requestPartnerConsentsBackoffice/Client
// (features/partners/actions.ts); the token itself is the sole
// authorization, exactly like a Supabase Auth magic link.
//
// ONE page, ONE token, TWO independent consent blocks rendered together —
// never two separate pages/routes. The token can resolve either (or both)
// of two separate database columns (consent_token_hash vs
// whatsapp_consent_token_hash, see consentLookup.ts::getPartnerConsentRequests)
// depending on which consent(s) were actually eligible for a request when
// the email was sent — but EACH block below only ever reflects, and only
// ever lets the partner act on, its OWN column's current status. Accepting
// or declining one consent can never touch the other's status: the buttons
// for each block call a DIFFERENT server action (consentActions.ts), each
// independently scoped by its own token-hash column AND its own
// "pending"-only guard.
import { getPartnerConsentRequests } from "@/features/partners/consentLookup";
import { ConsentResponseButtons } from "./ConsentResponseButtons";
import { TransactionalConsentResponseButtons } from "./TransactionalConsentResponseButtons";
import type { HotelPartnerConsentStatus } from "@/types/database";

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
      <p className="text-xs text-body">Ce lien de confirmation est invalide ou a expiré.</p>
    </Card>
  );
}

/** Shown for a block whose own status is NOT "pending" — each block reads ONLY its own column's status, independently of the other block. */
function ConsentStatusMessage({ status }: { status: Exclude<HotelPartnerConsentStatus, "pending"> }) {
  const message =
    status === "accepted"
      ? "Vous avez déjà accepté cette autorisation — merci."
      : status === "declined"
        ? "Vous avez déjà refusé cette autorisation."
        : "Aucune demande n'est actuellement en attente pour cette autorisation.";
  return <p className="text-xs text-body">{message}</p>;
}

export default async function PartnerConsentPage({ searchParams }: PageProps<"/partenaires/consentement">) {
  const resolvedSearchParams = await searchParams;
  const rawToken = resolvedSearchParams?.token;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;

  const request = token ? await getPartnerConsentRequests(token) : null;
  if (!request) return <InvalidLink />;

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold text-ink">Vos autorisations</h1>
      <p className="mb-6 text-xs text-body">
        L&rsquo;établissement <strong>{request.hotelName}</strong> souhaite vous référencer comme partenaire, <strong>{request.partnerName}</strong>.
        Ces deux autorisations sont indépendantes : vous pouvez accepter l&rsquo;une et refuser l&rsquo;autre.
      </p>

      <div className="mb-6 border-b border-border pb-6">
        <h2 className="mb-2 text-sm font-semibold text-ink">Recommandation dans le chatbot</h2>
        <p className="mb-4 text-xs text-body">
          J&rsquo;accepte que <strong>{request.hotelName}</strong> me recommande auprès de ses clients via son assistant virtuel.
        </p>
        {request.recommendation.status === "pending" ? (
          <ConsentResponseButtons token={token as string} initialOpeningHours={request.recommendation.openingHours} initialAddress={request.recommendation.address} />
        ) : (
          <ConsentStatusMessage status={request.recommendation.status} />
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-ink">Réception des demandes clients via WhatsApp</h2>
        <p className="mb-4 text-xs text-body">
          J&rsquo;accepte que Proactif System utilise le numéro indiqué par l&rsquo;établissement afin de me transmettre les demandes de ses
          clients via WhatsApp. Je pourrai refuser une demande individuellement.
          {request.whatsapp.requestPhoneE164 && (
            <>
              {" "}
              Numéro concerné : <strong>{request.whatsapp.requestPhoneE164}</strong>.
            </>
          )}
        </p>
        {request.whatsapp.status === "pending" ? (
          <TransactionalConsentResponseButtons token={token as string} />
        ) : (
          <ConsentStatusMessage status={request.whatsapp.status} />
        )}
      </div>
    </Card>
  );
}
