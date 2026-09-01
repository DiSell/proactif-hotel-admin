"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { maskPhoneForDisplay } from "@/features/partnerRequests/phoneRedaction";
import { approveSpaBookingClient, cancelSpaBookingClient } from "./actions";
import type { SpaBooking, SpaBookingStatus } from "@/types/database";

function formatBookingDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

/** Postgres `time` may come back as "HH:MM:SS" — trimmed to "HH:MM" for display. */
function formatSlotTime(value: string): string {
  return value.slice(0, 5);
}

const STATUS_BADGE: Record<SpaBookingStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  pending_approval: { label: "En attente de validation", tone: "warning" },
  confirmed: { label: "Confirmée", tone: "success" },
  cancelled: { label: "Annulée", tone: "neutral" },
};

interface SpaBookingsListProps {
  hotelId: string;
  bookings: SpaBooking[];
}

/**
 * /client/chatbot's own "Réservations spa" list — same list+ConfirmDialog
 * shape as features/events/EventsManager.tsx, but read-mostly: bookings are
 * only ever created by the chatbot flow (features/rag/spaBookingFlow.ts),
 * never from this UI. Two actions depending on status:
 * "pending_approval" (hotel_spa_settings.approval_mode = "manual",
 * 0035_spa_booking_approval.sql) gets Confirmer/Refuser — the fallback UI
 * path that always works regardless of whether WhatsApp is configured;
 * "confirmed" keeps its original "Annuler" action.
 */
export function SpaBookingsList({ hotelId, bookings }: SpaBookingsListProps) {
  const router = useRouter();
  const toast = useToast();
  const [cancelTarget, setCancelTarget] = useState<SpaBooking | null>(null);
  const [isPending, startTransition] = useTransition();
  const [approvingId, setApprovingId] = useState<string | null>(null);

  function handleCancel() {
    if (!cancelTarget) return;
    const target = cancelTarget;
    const wasPendingApproval = target.status === "pending_approval";
    startTransition(async () => {
      const result = await cancelSpaBookingClient(hotelId, target.id);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setCancelTarget(null);
      toast.show(wasPendingApproval ? "Réservation refusée." : "Réservation annulée.");
      router.refresh();
    });
  }

  function handleApprove(booking: SpaBooking) {
    setApprovingId(booking.id);
    startTransition(async () => {
      const result = await approveSpaBookingClient(hotelId, booking.id);
      setApprovingId(null);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Réservation confirmée.");
      router.refresh();
    });
  }

  if (bookings.length === 0) {
    return <EmptyState title="Aucune réservation spa pour le moment." description="Les réservations effectuées par vos visiteurs via le chatbot apparaîtront ici." />;
  }

  return (
    <div className="flex flex-col gap-3">
      {bookings.map((booking) => {
        const badge = STATUS_BADGE[booking.status];
        return (
          <Card key={booking.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-ink">
                  {formatBookingDate(booking.booking_date)} · {formatSlotTime(booking.slot_start)}–{formatSlotTime(booking.slot_end)}
                </p>
                <StatusBadge label={badge.label} tone={badge.tone} />
                {booking.is_non_resident && <StatusBadge label="Client extérieur" tone="neutral" />}
              </div>
              <p className="mt-1 text-2xs text-body/70">
                {booking.guest_name ?? "Nom non communiqué"} · {booking.party_size} personne(s)
                {booking.guest_phone_e164 ? ` · ${maskPhoneForDisplay(booking.guest_phone_e164)}` : ""}
              </p>
              {booking.notes && <p className="mt-1 text-2xs text-body/60">{booking.notes}</p>}
            </div>
            {booking.status === "pending_approval" && (
              <div className="flex shrink-0 gap-1">
                <Button variant="primary" size="sm" className="h-7 px-2 text-2xs" onClick={() => handleApprove(booking)} disabled={isPending && approvingId === booking.id}>
                  Confirmer
                </Button>
                <Button variant="danger" size="sm" className="h-7 px-2 text-2xs" onClick={() => setCancelTarget(booking)}>
                  Refuser
                </Button>
              </div>
            )}
            {booking.status === "confirmed" && (
              <div className="flex shrink-0 gap-1">
                <Button variant="danger" size="sm" className="h-7 px-2 text-2xs" onClick={() => setCancelTarget(booking)}>
                  Annuler
                </Button>
              </div>
            )}
          </Card>
        );
      })}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        title={cancelTarget?.status === "pending_approval" ? "Refuser cette réservation ?" : "Annuler cette réservation ?"}
        description="Le client ne sera pas automatiquement prévenu par le chatbot — pensez à le contacter directement si nécessaire."
        confirmLabel={cancelTarget?.status === "pending_approval" ? "Refuser" : "Annuler la réservation"}
        onConfirm={handleCancel}
        onCancel={() => setCancelTarget(null)}
        pending={isPending}
      />
    </div>
  );
}
