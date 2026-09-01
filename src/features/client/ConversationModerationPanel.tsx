"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { blockConversationClient, unblockConversationClient } from "./actions";

interface ConversationModerationPanelProps {
  conversationId: string;
  flaggedAt: string | null;
  flagReason: string | null;
  blockedAt: string | null;
}

/**
 * The only place a hotel_admin acts on a conversation's moderation state —
 * see block_conversation()/unblock_conversation()/flag_conversation()
 * (0036_conversation_moderation.sql). flaggedAt is informational only (set
 * automatically by the model's own moderation self-report, features/rag/moderation.ts);
 * blocking is always a manual, deliberate decision made here.
 */
export function ConversationModerationPanel({ conversationId, flaggedAt, flagReason, blockedAt }: ConversationModerationPanelProps) {
  const router = useRouter();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    startTransition(async () => {
      const result = blockedAt ? await unblockConversationClient(conversationId) : await blockConversationClient(conversationId);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setConfirmOpen(false);
      toast.show(blockedAt ? "Visiteur débloqué." : "Visiteur bloqué.");
      router.refresh();
    });
  }

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        {blockedAt || flaggedAt ? (
          <div className="flex flex-wrap items-center gap-2">
            {blockedAt && <StatusBadge label="Conversation bloquée" tone="neutral" />}
            {flaggedAt && <StatusBadge label="Comportement signalé" tone="warning" />}
          </div>
        ) : (
          <p className="text-2xs text-body/60">Aucun signalement pour cette conversation.</p>
        )}
        {flagReason && <p className="mt-1 text-2xs text-body/70">Motif : {flagReason}</p>}
        {blockedAt && <p className="mt-1 text-2xs text-body/60">Ce visiteur ne peut plus envoyer de message sur cette conversation.</p>}
      </div>
      <Button variant={blockedAt ? "secondary" : "danger"} size="sm" onClick={() => setConfirmOpen(true)}>
        {blockedAt ? "Débloquer ce visiteur" : "Bloquer ce visiteur"}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        title={blockedAt ? "Débloquer ce visiteur ?" : "Bloquer ce visiteur ?"}
        description={
          blockedAt
            ? "Ce visiteur pourra à nouveau envoyer des messages sur cette conversation."
            : "Ce visiteur ne pourra plus envoyer de message sur cette conversation. Un visiteur qui ouvre une nouvelle conversation (par exemple après avoir effacé son navigateur) n'est pas concerné par ce blocage."
        }
        confirmLabel={blockedAt ? "Débloquer" : "Bloquer"}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmOpen(false)}
        pending={isPending}
      />
    </Card>
  );
}
