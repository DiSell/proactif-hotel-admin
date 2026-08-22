import { notFound } from "next/navigation";
import Link from "next/link";
import { getHotel } from "@/features/hotels/queries";
import { getChatbotSettings } from "@/features/assistant/queries";
import { ChatPreview } from "@/features/assistant/ChatPreview";

export default async function AssistantFullscreenTestPage({
  params,
}: PageProps<"/etablissements/[id]/assistant/test">) {
  const { id } = await params;
  const [hotel, settings] = await Promise.all([getHotel(id), getChatbotSettings(id)]);
  if (!hotel) notFound();

  return (
    <div className="flex h-dvh flex-col bg-canvas">
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-border bg-surface px-6">
        <div className="flex items-center gap-4">
          <Link
            href={`/etablissements/${hotel.id}/assistant`}
            aria-label="Fermer le mode test"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-ink hover:bg-canvas"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </Link>
          <div className="h-6 w-px bg-border" />
          <div>
            <p className="text-xs font-medium text-ink">Mode test — {hotel.assistant_name || "Assistant"}</p>
            <p className="text-2xs text-body">{hotel.name}</p>
          </div>
        </div>
      </div>
      <div className="border-b border-border bg-canvas px-6 py-3 text-center">
        <span className="text-2xs text-body/80">
          Cette conversation utilise les réglages actuels de {hotel.name} et appelle le moteur réel (OpenAI + base de
          connaissances). Elle est enregistrée.
        </span>
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col overflow-hidden p-6">
        <ChatPreview
          hotelId={hotel.id}
          assistantName={hotel.assistant_name || "Assistant"}
          welcomeMessage={settings?.welcome_message || "Bonjour, comment puis-je vous aider ?"}
          fullScreen
        />
      </div>
    </div>
  );
}
