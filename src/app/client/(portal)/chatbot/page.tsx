import { createClientPortalClient } from "@/lib/supabase/server";
import { getClientChatbotInfo, getClientWidgetInfo } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { ChatbotPersonalizationForm } from "@/features/client/ChatbotPersonalizationForm";
import { DEFAULT_ASSISTANT_NAME } from "@/features/client/schema";
import { DEFAULT_WELCOME_MESSAGE } from "@/features/widget/publicHotel";
import { listHotelEvents } from "@/features/events/queries";
import { EventsManager } from "@/features/events/EventsManager";

export default async function ClientChatbotPage() {
  const [chatbotData, widgetData] = await Promise.all([getClientChatbotInfo(), getClientWidgetInfo()]);
  // hotelId comes from getClientChatbotInfo()'s own requireClientAccess()
  // call above — never re-derived or trusted from anywhere else. The
  // client-portal cookie scope (lib/supabase/cookieScope.ts) is what makes
  // listHotelEvents' RLS-scoped read see only this hotel's own rows.
  const events = await listHotelEvents(chatbotData.hotelId, await createClientPortalClient());

  // Assistant name: hotels.assistant_name — reused as-is (no new column).
  // Welcome message: widget_settings.welcome_message, NOT
  // chatbot_settings.welcome_message — that's the field the real public
  // widget actually reads (see features/widget/publicHotel.ts and
  // supabase/migrations/0014_chatbot_personalization.sql's own comment on
  // why).
  const assistantName = chatbotData.hotel.assistant_name || DEFAULT_ASSISTANT_NAME;
  const welcomeMessage = widgetData.widgetSettings?.welcome_message || DEFAULT_WELCOME_MESSAGE;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Chatbot" subtitle="Personnalisez votre assistant, puis testez-le exactement comme le ferait un visiteur de votre site." />

      <ChatbotPersonalizationForm
        hotelId={chatbotData.hotelId}
        initialAssistantName={assistantName}
        initialWelcomeMessage={welcomeMessage}
      />

      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Événements / Informations</h2>
          <p className="mt-1 text-xs text-body">
            Ajoutez des informations permanentes (ex. « le spa est accessible sans réserver de chambre ») ou des événements temporaires (ex. « spa
            fermé du 12 au 18 septembre ») que votre chatbot utilisera automatiquement dans ses réponses.
          </p>
        </div>
        <EventsManager hotelId={chatbotData.hotelId} events={events} />
      </div>
    </div>
  );
}
