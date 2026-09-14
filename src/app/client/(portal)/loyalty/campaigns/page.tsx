import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { getCampaigns } from "@/features/loyalty/queries";

export default async function CampaignsPage() {
  const rows = await getCampaigns();

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Campagnes" subtitle="Campagnes générales et ciblées." backHref="/client/loyalty" backLabel="Fidélisation" />

      <div>
        <Link href="/client/loyalty/campaigns/new" className="rounded-lg bg-ink px-4 py-2 text-xs text-canvas">
          Nouvelle campagne
        </Link>
      </div>

      <Card className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="p-5 text-xs text-body">Aucune campagne.</p>
        ) : (
          rows.map((campaign) => (
            <Link key={campaign.id} href={`/client/loyalty/campaigns/${campaign.id}`} className="grid grid-cols-3 border-b border-border px-5 py-4 text-xs">
              <span>{campaign.internal_name}</span>
              <span>{campaign.scheduled_at ? new Date(campaign.scheduled_at).toLocaleString("fr-FR") : "Brouillon"}</span>
              <StatusBadge label={campaign.status} tone={campaign.status === "sent" ? "success" : campaign.status === "cancelled" ? "danger" : "neutral"} />
            </Link>
          ))
        )}
      </Card>
    </div>
  );
}
