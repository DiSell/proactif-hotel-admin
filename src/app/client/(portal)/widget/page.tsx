import { getClientWidgetInfo } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { ClientWidgetInfo } from "@/features/widget/ClientWidgetInfo";

export default async function ClientWidgetPage() {
  const data = await getClientWidgetInfo();

  return (
    <div className="mx-auto flex max-w-[700px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Installation" subtitle="Le widget de chat à intégrer sur votre site." />

      <Card className="p-6">
        <ClientWidgetInfo hotel={data.hotel} widgetSettings={data.widgetSettings} />
      </Card>
    </div>
  );
}
