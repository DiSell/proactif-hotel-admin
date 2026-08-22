import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { getChatbotSettings } from "@/features/assistant/queries";
import { AssistantSettingsForm } from "@/features/assistant/AssistantSettingsForm";
import { ChatPreview } from "@/features/assistant/ChatPreview";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export default async function AssistantPage({ params }: PageProps<"/etablissements/[id]/assistant">) {
  const { id } = await params;
  const [hotel, settings] = await Promise.all([getHotel(id), getChatbotSettings(id)]);
  if (!hotel) notFound();

  return (
    <div className="grid grid-cols-1 gap-6 pb-8 lg:grid-cols-[1fr_400px]">
      <Card className="p-8">
        <AssistantSettingsForm hotel={hotel} settings={settings} />
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Aperçu en direct</span>
          <Button href={`/etablissements/${hotel.id}/assistant/test`} variant="secondary" size="sm">
            Plein écran
          </Button>
        </div>
        <div className="h-[520px]">
          <ChatPreview
            hotelId={hotel.id}
            assistantName={hotel.assistant_name || "Assistant"}
            welcomeMessage={settings?.welcome_message || "Bonjour, comment puis-je vous aider ?"}
          />
        </div>
      </div>
    </div>
  );
}
