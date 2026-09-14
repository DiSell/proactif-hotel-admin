import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { CampaignForm } from "@/features/loyalty/CampaignForm";
import { getCampaignBuilderData } from "@/features/loyalty/queries";

export default async function NewCampaignPage() {
  const customers = await getCampaignBuilderData();

  return (
    <div className="mx-auto flex max-w-[800px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Nouvelle campagne" subtitle="L’éligibilité sera recalculée au moment réel de l’envoi." backHref="/client/loyalty/campaigns" backLabel="Campagnes" />
      <Card className="p-6">
        <CampaignForm customers={customers} />
      </Card>
    </div>
  );
}
