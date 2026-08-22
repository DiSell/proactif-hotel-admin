import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { getWidgetSettings } from "@/features/widget/queries";
import { WidgetSettingsForm } from "@/features/widget/WidgetSettingsForm";
import { Card } from "@/components/ui/Card";

export default async function WidgetPage({ params }: PageProps<"/etablissements/[id]/widget">) {
  const { id } = await params;
  const [hotel, settings] = await Promise.all([getHotel(id), getWidgetSettings(id)]);
  if (!hotel) notFound();

  return (
    <div className="pb-8">
      <Card className="p-8">
        <WidgetSettingsForm hotel={hotel} settings={settings} />
      </Card>
    </div>
  );
}
