import { getClientChatbotInfo, getClientWidgetInfo } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { ChatbotPersonalizationForm } from "@/features/client/ChatbotPersonalizationForm";
import { DEFAULT_ASSISTANT_NAME } from "@/features/client/schema";
import { DEFAULT_WELCOME_MESSAGE } from "@/features/widget/publicHotel";

export default async function ClientChatbotPage() {
  const [chatbotData, widgetData] = await Promise.all([getClientChatbotInfo(), getClientWidgetInfo()]);

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
    </div>
  );
}
