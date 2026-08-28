import { Card } from "@/components/ui/Card";
import {
  PARTNER_REQUEST_ACTOR_LABELS,
  PARTNER_REQUEST_EVENT_LABELS,
  formatPartnerRequestCreatedAt,
} from "./presentation";
import type { PartnerRequestEvent } from "./types";

interface PartnerRequestEventsTimelineProps {
  events: PartnerRequestEvent[];
}

/**
 * Renders ONLY event_type (via its readable label)/actor_type/created_at/
 * message — metadata is intentionally never read or rendered here: it's an
 * internal, technical bag (delivery attempt details, provider ids, etc.),
 * never vetted for guest-facing/hotel-admin-facing display. message itself
 * is operator-authored free text (see 0020_partner_requests.sql), shown
 * as-is like partner_response elsewhere in this feature.
 */
export function PartnerRequestEventsTimeline({ events }: PartnerRequestEventsTimelineProps) {
  if (events.length === 0) {
    return <p className="text-xs text-body">Aucun historique pour cette demande.</p>;
  }

  return (
    <Card className="flex flex-col divide-y divide-border p-0">
      {events.map((event) => (
        <div key={event.id} className="flex flex-col gap-1 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium text-ink">{PARTNER_REQUEST_EVENT_LABELS[event.event_type]}</p>
            <span className="text-2xs text-body/60">{formatPartnerRequestCreatedAt(event.created_at)}</span>
          </div>
          <p className="text-2xs text-body/70">{PARTNER_REQUEST_ACTOR_LABELS[event.actor_type]}</p>
          {event.message && <p className="text-2xs text-ink">{event.message}</p>}
        </div>
      ))}
    </Card>
  );
}
