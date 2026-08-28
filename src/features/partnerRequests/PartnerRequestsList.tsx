"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge } from "@/components/ui/StatusBadge";
import {
  PARTNER_REQUEST_FILTERS,
  PARTNER_REQUEST_STATUS_LABELS,
  formatPartnerRequestCreatedAt,
  formatPartnerRequestDate,
  formatPartnerRequestTime,
  matchesPartnerRequestFilter,
  statusBadgeTone,
  type PartnerRequestFilterKey,
} from "./presentation";
import type { PartnerRequest } from "./types";

interface PartnerRequestsListProps {
  requests: PartnerRequest[];
  /** partner_id -> partner name, resolved server-side via the already-validated features/partners/queries.ts (never a raw ad hoc read). */
  partnerNames: Record<string, string>;
}

/**
 * Read-only: no action/mutation is wired here at all (no import from
 * ./actions) — this is deliberately a pure display screen for this first
 * version. Never receives/renders guest_phone_e164 — the query this data
 * comes from (listPartnerRequestsForHotel) excludes it entirely, so there is
 * nothing to accidentally leak here even by mistake.
 */
export function PartnerRequestsList({ requests, partnerNames }: PartnerRequestsListProps) {
  const [filter, setFilter] = useState<PartnerRequestFilterKey>("all");

  if (requests.length === 0) {
    return <EmptyState title="Vous n'avez encore aucune demande partenaire." />;
  }

  // requests is already sorted most-recent-first by the query
  // (listPartnerRequestsForHotel orders by created_at desc) — never re-sorted here.
  const filtered = requests.filter((request) => matchesPartnerRequestFilter(request.status, filter));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {PARTNER_REQUEST_FILTERS.map((item) => (
          <Button
            key={item.key}
            type="button"
            variant={filter === item.key ? "primary" : "secondary"}
            size="sm"
            onClick={() => setFilter(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="py-8 text-center text-xs text-body">Aucune demande dans ce filtre.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((request) => (
            <Link key={request.id} href={`/client/requests/${request.id}`}>
              <Card className="flex flex-wrap items-center justify-between gap-3 p-4 hover:border-border-hover">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{partnerNames[request.partner_id] ?? "Partenaire"}</p>
                    <StatusBadge label={PARTNER_REQUEST_STATUS_LABELS[request.status]} tone={statusBadgeTone(request.status)} />
                  </div>
                  <p className="mt-1 text-2xs text-body/70">
                    {request.request_category} · {formatPartnerRequestDate(request.requested_date)} ·{" "}
                    {formatPartnerRequestTime(request.requested_time)}
                    {request.party_size ? ` · ${request.party_size} pers.` : ""}
                  </p>
                </div>
                <span className="shrink-0 text-2xs text-body/60">{formatPartnerRequestCreatedAt(request.created_at)}</span>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
