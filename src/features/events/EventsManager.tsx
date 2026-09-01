"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { EventFormModal } from "./EventFormModal";
import { deleteHotelEventClient, setHotelEventActiveClient } from "./actions";
import { HOTEL_EVENT_TYPE_LABEL } from "./schema";
import type { HotelEvent } from "@/types/database";

type DisplayState = "active" | "upcoming" | "expired" | "disabled";

const STATE_BADGE: Record<DisplayState, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  active: { label: "Actif", tone: "success" },
  upcoming: { label: "Futur", tone: "warning" },
  expired: { label: "Expiré", tone: "neutral" },
  disabled: { label: "Désactivé", tone: "neutral" },
};

/**
 * Display-only classification — never what the chatbot itself uses to
 * decide relevance (see features/rag/events.ts::loadActiveHotelEvents,
 * a separate, server-side query). Today's date is read client-side, purely
 * for this badge; a few hours of timezone drift around midnight is an
 * acceptable MVP tradeoff for a label, unlike the server-side prompt
 * selection which always uses the server's own date.
 */
function displayState(event: HotelEvent): DisplayState {
  if (!event.is_active) return "disabled";
  if (event.type === "permanent") return "active";
  const todayIso = new Date().toISOString().slice(0, 10);
  if (event.starts_at && todayIso < event.starts_at) return "upcoming";
  if (event.ends_at && todayIso > event.ends_at) return "expired";
  return "active";
}

function formatEventDate(value: string | null): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

interface EventsManagerProps {
  hotelId: string;
  events: HotelEvent[];
}

/**
 * /client/chatbot's own "Événements / Informations" section — same
 * list+modal shape as features/partners/PartnersManager.tsx, reusing the
 * exact same UI atoms. Only the "client" scope exists today (see
 * actions.ts's own doc comment) — this component is therefore NOT given an
 * `actions` bundle prop the way PartnersManager is; it imports the
 * *Client actions directly, since no back-office variant exists to choose
 * between yet.
 */
export function EventsManager({ hotelId, events }: EventsManagerProps) {
  const router = useRouter();
  const toast = useToast();
  const [formTarget, setFormTarget] = useState<HotelEvent | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HotelEvent | null>(null);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  function toggleActive(event: HotelEvent) {
    setPendingId(event.id);
    startTransition(async () => {
      const result = await setHotelEventActiveClient(hotelId, event.id, !event.is_active);
      setPendingId(null);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.refresh();
    });
  }

  function handleDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    startTransition(async () => {
      const result = await deleteHotelEventClient(hotelId, target.id);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setDeleteTarget(null);
      toast.show("Événement supprimé.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setFormTarget("new")}>
          + Ajouter un événement
        </Button>
      </div>

      {events.length === 0 ? (
        <EmptyState
          title="Aucun événement ou information pour le moment."
          description="Ajoutez une information permanente (ex. « le spa est accessible sans réserver de chambre ») ou un événement temporaire (ex. « spa fermé du 12 au 18 septembre ») que votre chatbot pourra utiliser dans ses réponses."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {events.map((event) => {
            const state = displayState(event);
            return (
              <Card key={event.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{event.title}</p>
                    <StatusBadge label={STATE_BADGE[state].label} tone={STATE_BADGE[state].tone} />
                    {event.show_as_banner && <StatusBadge label="Bandeau" tone="neutral" />}
                  </div>
                  <p className="mt-1 text-2xs text-body/70">
                    {HOTEL_EVENT_TYPE_LABEL[event.type]}
                    {event.type === "temporary" ? ` · Du ${formatEventDate(event.starts_at)} au ${formatEventDate(event.ends_at)}` : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-2xs" onClick={() => setFormTarget(event)}>
                    Modifier
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-2xs"
                    onClick={() => toggleActive(event)}
                    disabled={isPending && pendingId === event.id}
                  >
                    {event.is_active ? "Désactiver" : "Activer"}
                  </Button>
                  <Button variant="danger" size="sm" className="h-7 px-2 text-2xs" onClick={() => setDeleteTarget(event)}>
                    Supprimer
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {formTarget && (
        <EventFormModal
          hotelId={hotelId}
          event={formTarget === "new" ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onSaved={() => {
            setFormTarget(null);
            router.refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Supprimer cet événement ?"
        description={`« ${deleteTarget?.title ?? ""} » sera définitivement supprimé et ne sera plus utilisé par le chatbot. Cette action est irréversible.`}
        confirmLabel="Supprimer"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        pending={isPending}
      />
    </div>
  );
}
