import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CancelCampaignButton } from "@/features/loyalty/CancelCampaignButton";
import { getCampaignDetail } from "@/features/loyalty/queries";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCampaignDetail(id);
  if (!data) notFound();
  const { campaign, selected, deliveries } = data;

  return (
    <div className="mx-auto flex max-w-[850px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title={campaign.internal_name} subtitle="Détail de la campagne" backHref="/client/loyalty/campaigns" backLabel="Campagnes" />

      <Card className="p-5">
        <div className="mb-4 flex justify-between">
          <h2 className="text-sm font-semibold">{campaign.subject}</h2>
          <StatusBadge label={campaign.status} tone={campaign.status === "sent" ? "success" : campaign.status === "cancelled" ? "danger" : "neutral"} />
        </div>
        <p className="whitespace-pre-wrap text-xs">{campaign.content}</p>
        {campaign.offer_text && <p className="mt-3 rounded-lg bg-canvas p-3 text-xs font-medium">{campaign.offer_text}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
          <p>Audience : {campaign.audience_type}</p>
          <p>Sélection : {campaign.audience_type === "targeted" ? selected.length : "Tous les éligibles"}</p>
          <p>Date : {campaign.scheduled_at ? new Date(campaign.scheduled_at).toLocaleString("fr-FR") : "Non programmée"}</p>
          <p>Canal : email</p>
        </div>
        {["draft", "scheduled"].includes(campaign.status) && (
          <div className="mt-5">
            <CancelCampaignButton id={campaign.id} />
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Historique des envois</h2>
        {deliveries.length === 0 ? (
          <p className="text-xs text-body">Aucun envoi.</p>
        ) : (
          deliveries.map((delivery) => (
            <div key={delivery.id} className="grid grid-cols-3 border-t border-border py-2 text-xs">
              <span>{delivery.customer_id.slice(0, 8)}</span>
              <StatusBadge label={delivery.status} tone={delivery.status === "sent" ? "success" : delivery.status === "failed" ? "danger" : "neutral"} />
              <span>{delivery.safe_error || delivery.sent_at || "—"}</span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
