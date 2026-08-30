import { getHotelWhatsAppConnectionForClient } from "@/features/whatsappIntegration/queries";
import { EmbeddedSignupButton } from "@/features/whatsappIntegration/EmbeddedSignupButton";
import { PageHeader } from "@/components/layout/PageHeader";
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

/**
 * The MAIN WhatsApp connection path — a hotel_admin already signed into
 * their own client portal connects WhatsApp for their OWN establishment
 * directly, no link/token involved (that remains the OPTIONAL path for
 * someone with no Proactif account, /whatsapp/connect/[token], untouched).
 *
 * hotelId is resolved EXCLUSIVELY server-side by
 * getHotelWhatsAppConnectionForClient() (requireClientAccess()) — never
 * read from this page's own props/params, since none exist: this route has
 * no [id] segment at all, unlike the admin equivalent.
 *
 * Never renders WABA id / phone_number_id / business_id / any crypto
 * material — only the non-secret connection_type/connected_at, same
 * minimization principle as the admin page.
 */
export default async function ClientWhatsAppPage() {
  const connection = await getHotelWhatsAppConnectionForClient();
  const isConnected = connection?.status === "active";
  const isError = connection?.status === "error";

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="WhatsApp Business" subtitle="Connectez le compte WhatsApp Business de votre établissement." />

      <Card className="max-w-xl p-8">
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
                Erreur de connexion — la dernière tentative n&rsquo;a pas abouti. Vous pouvez réessayer ci-dessous.
              </p>
            )}
            <EmbeddedSignupButton mode="client" />
          </>
        )}
      </Card>
    </div>
  );
}
