import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { LoyaltySettingsForm } from "@/features/loyalty/LoyaltySettingsForm";
import { getLoyaltyOverview } from "@/features/loyalty/queries";

export default async function LoyaltyPage() {
  const data = await getLoyaltyOverview();

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Fidélisation" subtitle="Suivi après séjour et campagnes marketing." />

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Suivi après séjour</h2>
          <LoyaltySettingsForm settings={data.settings} />
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 text-sm font-semibold">Campagnes</h2>
          <p className="mb-4 text-xs text-body">{data.deliveries} communication(s) journalisée(s).</p>
          <div className="flex gap-2">
            <Link href="/client/loyalty/campaigns" className="rounded-lg border border-border px-4 py-2 text-xs">
              Voir les campagnes
            </Link>
            <Link href="/client/loyalty/campaigns/new" className="rounded-lg bg-ink px-4 py-2 text-xs text-canvas">
              Nouvelle campagne
            </Link>
          </div>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Campagnes récentes</h2>
        {data.campaigns.map((campaign) => (
          <Link key={campaign.id} href={`/client/loyalty/campaigns/${campaign.id}`} className="flex justify-between border-t border-border py-3 text-xs">
            <span>{campaign.internal_name}</span>
            <StatusBadge label={campaign.status} tone={campaign.status === "sent" ? "success" : campaign.status === "cancelled" ? "danger" : "neutral"} />
          </Link>
        ))}
      </Card>
    </div>
  );
}
