import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  PARTNER_REQUEST_STATUS_LABELS,
  formatPartnerRequestCreatedAt,
  formatPartnerRequestDate,
  formatPartnerRequestTime,
  statusBadgeTone,
} from "./presentation";
import type { PartnerRequest } from "./types";

interface FieldProps {
  label: string;
  value: string;
}

function Field({ label, value }: FieldProps) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wide text-body/60">{label}</p>
      <p className="mt-0.5 text-xs text-ink">{value}</p>
    </div>
  );
}

interface PartnerRequestDetailCardProps {
  request: PartnerRequest;
  partnerName: string;
}

/**
 * Deliberately never renders guest_phone_e164 — the request itself doesn't
 * carry it (getPartnerRequestById reuses the same PII-excluding column list
 * as listPartnerRequestsForHotel — see queries.ts's own doc comment); there
 * is no separately-scoped, hotel_admin-authorized PII detail query yet, so
 * none is added here (see this task's own final report).
 */
export function PartnerRequestDetailCard({ request, partnerName }: PartnerRequestDetailCardProps) {
  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink">{partnerName}</p>
        <StatusBadge label={PARTNER_REQUEST_STATUS_LABELS[request.status]} tone={statusBadgeTone(request.status)} />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Field label="Catégorie" value={request.request_category} />
        <Field label="Date demandée" value={formatPartnerRequestDate(request.requested_date)} />
        <Field label="Heure demandée" value={formatPartnerRequestTime(request.requested_time)} />
        <Field label="Nombre de personnes" value={request.party_size ? String(request.party_size) : "—"} />
        <Field label="Nom client" value={request.guest_name ?? "—"} />
        <Field label="Créée le" value={formatPartnerRequestCreatedAt(request.created_at)} />
      </div>

      {request.details && (
        <div>
          <p className="text-2xs uppercase tracking-wide text-body/60">Détails</p>
          <p className="mt-0.5 whitespace-pre-wrap text-xs text-ink">{request.details}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
        <Field label="Dernière réponse du partenaire" value={request.partner_response ?? "—"} />
        <Field label="Date de réponse" value={request.responded_at ? formatPartnerRequestCreatedAt(request.responded_at) : "—"} />
      </div>
    </Card>
  );
}
