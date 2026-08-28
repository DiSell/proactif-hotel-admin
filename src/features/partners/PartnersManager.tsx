"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { PartnerFormModal } from "./PartnerFormModal";
import { HOTEL_PARTNER_CATEGORY_LABEL } from "./schema";
import type { HotelPartner, HotelPartnerConsentStatus } from "@/types/database";
import type { PartnerActions } from "./actionBundles";

const CONSENT_BADGE: Record<HotelPartnerConsentStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  not_requested: { label: "Consentement non demandé", tone: "neutral" },
  pending: { label: "Consentement en attente", tone: "warning" },
  accepted: { label: "Consentement accepté", tone: "success" },
  declined: { label: "Consentement refusé", tone: "danger" },
};

interface PartnersManagerProps {
  hotelId: string;
  partners: HotelPartner[];
  /**
   * The whole bundle of scope-bound Server Actions to use — NEVER a
   * `scope` string. The page passes PARTNER_ACTIONS_BACKOFFICE or
   * PARTNER_ACTIONS_CLIENT (features/partners/actionBundles.ts); this
   * component never decides or transmits which cookie scope is used, it
   * only ever invokes whichever function reference it was given. See
   * features/partners/actions.ts's own doc comment for why: a client
   * component must never be able to supply or influence the auth scope a
   * shared Server Action reads.
   */
  actions: PartnerActions;
}

/**
 * Shared between /client/partners (hotel_admin) and
 * /etablissements/[id]/partenaires (superadmin, managing on the client's
 * behalf) — identical UI and behavior for both. Already sorted priority
 * DESC, name ASC by the query (features/partners/queries.ts) — this
 * component never re-sorts.
 */
export function PartnersManager({ hotelId, partners, actions }: PartnersManagerProps) {
  const router = useRouter();
  const toast = useToast();
  const [formTarget, setFormTarget] = useState<HotelPartner | "new" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HotelPartner | null>(null);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);

  function toggleActive(partner: HotelPartner) {
    setPendingId(partner.id);
    startTransition(async () => {
      const result = await actions.setHotelPartnerActive(hotelId, partner.id, !partner.is_active);
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
      const result = await actions.deleteHotelPartner(hotelId, target.id);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setDeleteTarget(null);
      toast.show("Partenaire supprimé.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setFormTarget("new")}>
          + Ajouter un partenaire
        </Button>
      </div>

      {partners.length === 0 ? (
        <EmptyState
          title="Aucun partenaire pour le moment."
          description="Ajoutez un restaurant, un taxi, une activité… que votre chatbot pourra recommander à vos visiteurs."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {partners.map((partner) => (
            <Card key={partner.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-ink">{partner.name}</p>
                  <StatusBadge label={partner.is_active ? "Actif" : "Inactif"} tone={partner.is_active ? "success" : "neutral"} />
                  <StatusBadge label={CONSENT_BADGE[partner.consent_status].label} tone={CONSENT_BADGE[partner.consent_status].tone} />
                </div>
                <p className="mt-1 text-2xs text-body/70">
                  {HOTEL_PARTNER_CATEGORY_LABEL[partner.category]} · Priorité {partner.priority}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button variant="ghost" size="sm" className="h-7 px-2 text-2xs" onClick={() => setFormTarget(partner)}>
                  Modifier
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-2xs"
                  onClick={() => toggleActive(partner)}
                  disabled={isPending && pendingId === partner.id}
                >
                  {partner.is_active ? "Désactiver" : "Activer"}
                </Button>
                <Button variant="danger" size="sm" className="h-7 px-2 text-2xs" onClick={() => setDeleteTarget(partner)}>
                  Supprimer
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {formTarget && (
        <PartnerFormModal
          hotelId={hotelId}
          partner={formTarget === "new" ? null : formTarget}
          actions={actions}
          onClose={() => setFormTarget(null)}
          onSaved={() => {
            setFormTarget(null);
            router.refresh();
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Supprimer ce partenaire ?"
        description={`« ${deleteTarget?.name ?? ""} » sera définitivement supprimé et ne pourra plus être recommandé par le chatbot. Cette action est irréversible.`}
        confirmLabel="Supprimer"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        pending={isPending}
      />
    </div>
  );
}
