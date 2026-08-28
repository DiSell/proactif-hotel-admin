import { notFound } from "next/navigation";
import { getClientConversationDetail } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Never exposes: sources/similarity scores, prompts, tokens, logs,
 * session_id/session token — none of that is even fetched by
 * getClientConversationDetail (see features/client/queries.ts), so there
 * is nothing here to accidentally render. A conversationId belonging to
 * another hotel resolves to the exact same notFound() as an unknown one —
 * never a distinguishable response, even for a UUID the client somehow
 * already knows.
 */
export default async function ClientConversationDetailPage({ params }: PageProps<"/client/conversations/[conversationId]">) {
  const { conversationId } = await params;
  const conversation = await getClientConversationDetail(conversationId);
  if (!conversation) notFound();

  return (
    <div className="mx-auto flex max-w-[800px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Conversation" subtitle={formatDateTime(conversation.startedAt)} backHref="/client/conversations" backLabel="Conversations" />

      <Card className="flex flex-col gap-3 p-6">
        {conversation.messages.length === 0 ? (
          <p className="text-xs text-body">Aucun message dans cette conversation.</p>
        ) : (
          conversation.messages.map((message) => (
            <div key={message.id} className={`flex flex-col gap-1 ${message.role === "user" ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                  message.role === "user" ? "bg-ink text-canvas" : "border border-border bg-surface"
                }`}
              >
                {message.content}
              </div>
              <span className="text-2xs text-body/60">{formatDateTime(message.createdAt)}</span>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
