import Link from "next/link";
import { getClientConversations } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export default async function ClientConversationsPage() {
  const { conversations } = await getClientConversations();

  return (
    <div className="mx-auto flex max-w-[1000px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Conversations" subtitle="Historique des échanges de votre chatbot avec vos visiteurs." />

      <Card className="p-6">
        {conversations.length === 0 ? (
          <p className="text-xs text-body">Aucune conversation pour l&rsquo;instant.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {conversations.map((conversation) => (
              <Link
                key={conversation.id}
                href={`/client/conversations/${conversation.id}`}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5 hover:border-border-hover"
              >
                <div className="min-w-0">
                  <p className="text-2xs text-body">{formatDateTime(conversation.startedAt)}</p>
                  <p className="truncate text-xs text-ink">{conversation.lastMessagePreview ?? "—"}</p>
                </div>
                <span className="ml-3 shrink-0 text-2xs text-body">
                  {conversation.messageCount} message{conversation.messageCount > 1 ? "s" : ""}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
