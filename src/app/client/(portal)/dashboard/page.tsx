import Link from "next/link";
import { getClientDashboard } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export default async function ClientDashboardPage() {
  const data = await getClientDashboard();

  const hotelStatusLabel = data.hotel.status === "active" ? "Actif" : data.hotel.status === "draft" ? "Brouillon" : "Inactif";
  const hotelStatusTone = data.hotel.status === "active" ? "success" : data.hotel.status === "draft" ? "warning" : "neutral";
  const chatbotTone = data.hotel.assistant_enabled ? "success" : "neutral";
  const widgetActive = data.widgetSettings ? data.widgetSettings.is_active : true; // no row = active by default (see resolvePublicWidgetContext's own documented default)
  const widgetTone = widgetActive ? "success" : "neutral";

  return (
    <div className="mx-auto flex max-w-[1200px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        title={data.hotel.name}
        subtitle="Vue d'ensemble de votre activité Proactif."
        actions={
          <Button variant="primary" href="/client/chatbot">
            Tester mon chatbot
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card className="flex flex-col gap-2 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Établissement</span>
          <StatusBadge label={hotelStatusLabel} tone={hotelStatusTone} />
        </Card>
        <Card className="flex flex-col gap-2 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Chatbot</span>
          <StatusBadge label={data.hotel.assistant_enabled ? "Actif" : "Désactivé"} tone={chatbotTone} />
        </Card>
        <Card className="flex flex-col gap-2 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Widget</span>
          <StatusBadge label={widgetActive ? "Actif" : "Inactif"} tone={widgetTone} />
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        <Card className="flex flex-col gap-1 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Conversations (total)</span>
          <span className="text-2xl font-semibold text-ink">{data.totalConversations}</span>
        </Card>
        <Card className="flex flex-col gap-1 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Messages (total)</span>
          <span className="text-2xl font-semibold text-ink">{data.totalMessages}</span>
        </Card>
        <Card className="flex flex-col gap-1 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Conversations · 7 jours</span>
          <span className="text-2xl font-semibold text-ink">{data.conversations7d}</span>
        </Card>
        <Card className="flex flex-col gap-1 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Conversations · 30 jours</span>
          <span className="text-2xl font-semibold text-ink">{data.conversations30d}</span>
        </Card>
      </div>

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Conversations récentes</span>
          <Link href="/client/conversations" className="text-xs font-medium text-accent">
            Voir tout →
          </Link>
        </div>
        {data.recentConversations.length === 0 ? (
          <p className="text-xs text-body">Aucune conversation pour l&rsquo;instant.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {data.recentConversations.map((conversation) => (
              <Link
                key={conversation.id}
                href={`/client/conversations/${conversation.id}`}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 hover:border-border-hover"
              >
                <div className="min-w-0">
                  <p className="text-2xs text-body">{formatDateTime(conversation.startedAt)}</p>
                  <p className="truncate text-xs text-ink">{conversation.lastMessagePreview ?? "—"}</p>
                </div>
                <span className="ml-3 shrink-0 text-2xs text-body">{conversation.messageCount} message{conversation.messageCount > 1 ? "s" : ""}</span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
