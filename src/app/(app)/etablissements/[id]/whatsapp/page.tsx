import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { getHotelWhatsAppConnection, getHotelWhatsAppActivationLinkStatus } from "@/features/whatsappIntegration/queries";
import { GenerateActivationLinkButton } from "@/features/whatsappIntegration/GenerateActivationLinkButton";
import { Card } from "@/components/ui/Card";
import type { HotelWhatsAppConnectionType } from "@/features/whatsappIntegration/types";

const CONNECTION_TYPE_LABEL: Record<HotelWhatsAppConnectionType, string> = {
  coexistence: "Coexistence avec l'application WhatsApp Business",
  cloud_api_only: "API Cloud WhatsApp",
};

function formatConnectedAt(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

function formatExpiresAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

/**
 * WhatsApp Business configuration for ONE establishment, in the admin
 * dashboard — this is the ONLY place this configuration lives (the client
 * portal's own /client/whatsapp screen and its ClientSidebarNav entry have
 * been removed). `hotelId` comes from this admin route's own [id] param,
 * which HotelLayout (one level up) already resolved via getHotel().
 *
 * Never imports/renders EmbeddedSignupButton and never triggers Meta's
 * Embedded Signup itself — this page only generates/copies an activation
 * LINK (GenerateActivationLinkButton -> generateWhatsAppActivationLinkBackoffice,
 * both re-validated server-side via requireHotelAccess()). The hotel's own
 * WhatsApp Business owner is the one who opens that link
 * (/whatsapp/connect/[token], no Proactif account needed) and completes
 * Embedded Signup there.
 *
 * Never renders WABA id / phone_number_id / business_id / any crypto
 * material, and never the raw activation token/its hash — only the
 * non-secret connection_type/connected_at (getHotelWhatsAppConnection) and
 * whether a link is currently pending plus its expiry
 * (getHotelWhatsAppActivationLinkStatus), per this task's own minimization
 * principle.
 */
export default async function HotelWhatsAppPage({ params }: PageProps<"/etablissements/[id]/whatsapp">) {
  const { id } = await params;
  const [hotel, connection, activationLink] = await Promise.all([
    getHotel(id),
    getHotelWhatsAppConnection(id),
    getHotelWhatsAppActivationLinkStatus(id),
  ]);
  if (!hotel) notFound();

  const isConnected = connection?.status === "active";
  const isError = connection?.status === "error";
  const hasPendingLink = activationLink.status === "pending";

  return (
    <div className="pb-8">
      <Card className="max-w-xl p-8">
        <h2 className="text-lg font-semibold text-ink">WhatsApp Business</h2>
        <p className="mt-1 mb-6 text-xs text-body">Connectez le compte WhatsApp Business de cet établissement.</p>

        {isConnected ? (
          <div>
            <p className="text-xs font-medium text-ink">WhatsApp Business connecté</p>
            <dl className="mt-3 space-y-1 text-2xs text-body">
              <div className="flex gap-2">
                <dt className="text-body/70">Type de connexion</dt>
                <dd className="text-ink">{CONNECTION_TYPE_LABEL[connection.connection_type]}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-body/70">Connecté depuis</dt>
                <dd className="text-ink">{formatConnectedAt(connection.connected_at)}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <>
            {isError && (
              <p className="mb-3 text-xs font-medium text-danger">
                Erreur de connexion — la dernière tentative n&rsquo;a pas abouti. Vous pouvez générer un nouveau lien ci-dessous.
              </p>
            )}
            {hasPendingLink && (
              <p className="mb-3 text-xs font-medium text-ink">
                Activation en attente — un lien a été envoyé et n&rsquo;a pas encore été utilisé
                {activationLink.status === "pending" ? ` (expire le ${formatExpiresAt(activationLink.expiresAt)})` : ""}.
              </p>
            )}
            <GenerateActivationLinkButton hotelId={hotel.id} hasPendingLink={hasPendingLink} />
          </>
        )}
      </Card>
    </div>
  );
}
