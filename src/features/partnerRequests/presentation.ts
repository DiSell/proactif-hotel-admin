import type { PartnerRequestActorType, PartnerRequestEventType, PartnerRequestStatus } from "./types";

/**
 * Pure, UI-facing label/formatting helpers for the read-only client-portal
 * screen (src/app/client/(portal)/requests) — kept here, not inline in the
 * page/components, so they're unit-testable without jsdom (same convention
 * as the rest of this feature: schema.ts/stateMachine.ts/phoneRedaction.ts
 * are all pure and tested directly).
 */

export const PARTNER_REQUEST_STATUS_LABELS: Record<PartnerRequestStatus, string> = {
  draft: "Brouillon",
  pending_confirmation: "En attente de confirmation client",
  sent_to_partner: "Envoyée au partenaire",
  accepted: "Acceptée",
  rejected: "Refusée",
  alternative_proposed: "Alternative proposée",
  cancelled: "Annulée",
};

export const PARTNER_REQUEST_EVENT_LABELS: Record<PartnerRequestEventType, string> = {
  request_created: "Demande créée",
  guest_confirmation_requested: "Confirmation demandée au client",
  guest_confirmed: "Confirmée par le client",
  sent_to_partner: "Envoyée au partenaire",
  partner_delivery_failed: "Échec de transmission au partenaire",
  partner_accepted: "Acceptée par le partenaire",
  partner_rejected: "Refusée par le partenaire",
  partner_alternative_proposed: "Alternative proposée par le partenaire",
  guest_accepted_alternative: "Alternative acceptée par le client",
  guest_rejected_alternative: "Alternative refusée par le client",
  guest_notification_sent: "Client notifié",
  guest_notification_failed: "Échec de notification du client",
  cancelled: "Annulée",
};

export const PARTNER_REQUEST_ACTOR_LABELS: Record<PartnerRequestActorType, string> = {
  guest: "Client",
  partner: "Partenaire",
  hotel: "Hôtel",
  system: "Système",
};

/**
 * MVP status filter — deliberately coarser than the 7-value status
 * vocabulary itself (see AGENTS.md's "keep it minimal" discipline): the
 * request asked for exactly 4 buttons, not a filter per status.
 */
export type PartnerRequestFilterKey = "all" | "pending" | "accepted" | "declined";

export const PARTNER_REQUEST_FILTERS: { key: PartnerRequestFilterKey; label: string }[] = [
  { key: "all", label: "Toutes" },
  { key: "pending", label: "En attente" },
  { key: "accepted", label: "Acceptées" },
  { key: "declined", label: "Refusées / annulées" },
];

/**
 * "pending" groups every status that hasn't reached a business outcome yet
 * (draft/pending_confirmation/sent_to_partner/alternative_proposed) —
 * matches stateMachine.ts's own TERMINAL_STATUSES split, minus `accepted`
 * which gets its own button.
 */
export function matchesPartnerRequestFilter(status: PartnerRequestStatus, filter: PartnerRequestFilterKey): boolean {
  switch (filter) {
    case "all":
      return true;
    case "accepted":
      return status === "accepted";
    case "declined":
      return status === "rejected" || status === "cancelled";
    case "pending":
      return status === "draft" || status === "pending_confirmation" || status === "sent_to_partner" || status === "alternative_proposed";
  }
}

export function statusBadgeTone(status: PartnerRequestStatus): "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "accepted":
      return "success";
    case "rejected":
    case "cancelled":
      return "danger";
    case "sent_to_partner":
    case "alternative_proposed":
    case "pending_confirmation":
      return "warning";
    case "draft":
      return "neutral";
  }
}

/** requested_date is a real Postgres `date` column (YYYY-MM-DD) — see 0020_partner_requests.sql — never free text, unlike requested_time. */
export function formatPartnerRequestDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("fr-FR", { dateStyle: "medium" });
}

/** requested_time is free text (e.g. "20h", "vers midi") — displayed verbatim, never reparsed. */
export function formatPartnerRequestTime(value: string | null): string {
  return value ?? "—";
}

export function formatPartnerRequestCreatedAt(value: string): string {
  return new Date(value).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}
