import { createClientPortalClient } from "@/lib/supabase/server";
import { getClientChatbotInfo, getClientWidgetInfo } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { ChatbotPersonalizationForm } from "@/features/client/ChatbotPersonalizationForm";
import { DEFAULT_ASSISTANT_NAME } from "@/features/client/schema";
import { DEFAULT_WELCOME_MESSAGE } from "@/features/widget/publicHotel";
import { listHotelEvents } from "@/features/events/queries";
import { EventsManager } from "@/features/events/EventsManager";
import { getHotelSpaSettings, listSpaBookings } from "@/features/spa/queries";
import { SpaSettingsForm } from "@/features/spa/SpaSettingsForm";
import { SpaBookingsList } from "@/features/spa/SpaBookingsList";
import type { HotelEvent, HotelSpaSettings, SpaBooking } from "@/types/database";

export default async function ClientChatbotPage() {
  const [chatbotData, widgetData] = await Promise.all([getClientChatbotInfo(), getClientWidgetInfo()]);
  // hotelId comes from getClientChatbotInfo()'s own requireClientAccess()
  // call above — never re-derived or trusted from anywhere else. The
  // client-portal cookie scope (lib/supabase/cookieScope.ts) is what makes
  // listHotelEvents' RLS-scoped read see only this hotel's own rows.
  //
  // Caught here (rather than left to throw, unlike listHotelPartners' own
  // call sites) so that a failure specific to this ONE section — e.g.
  // migration 0032_hotel_events.sql not yet applied on a given environment
  // — degrades to an empty events list instead of crashing the entire
  // page, taking the already-working chatbot personalization form down
  // with it.
  let events: HotelEvent[];
  try {
    events = await listHotelEvents(chatbotData.hotelId, await createClientPortalClient());
  } catch (err) {
    console.error("ClientChatbotPage: listHotelEvents failed", { hotelId: chatbotData.hotelId, message: (err as Error).message });
    events = [];
  }

  // Same controlled-degradation pattern as listHotelEvents above (a
  // permanent, user-mandated requirement after a real production
  // incident): a query failure here must never crash the rest of the page.
  let spaSettings: HotelSpaSettings | null;
  let spaBookings: SpaBooking[];
  try {
    const spaSupabase = await createClientPortalClient();
    [spaSettings, spaBookings] = await Promise.all([getHotelSpaSettings(chatbotData.hotelId, spaSupabase), listSpaBookings(chatbotData.hotelId, spaSupabase)]);
  } catch (err) {
    console.error("ClientChatbotPage: spa queries failed", { hotelId: chatbotData.hotelId, message: (err as Error).message });
    spaSettings = null;
    spaBookings = [];
  }

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

      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">Réservation spa</h2>
          <p className="mt-1 text-xs text-body">
            Configurez les horaires, la durée des créneaux, le prix et la capacité de votre espace spa. Une fois activée, votre chatbot pourra prendre des
            réservations directement dans la conversation, et vous serez notifié par email à chaque réservation.
          </p>
        </div>
        <SpaSettingsForm hotelId={chatbotData.hotelId} settings={spaSettings} />
        <SpaBookingsList hotelId={chatbotData.hotelId} bookings={spaBookings} />
      </div>
    </div>
  );
}
