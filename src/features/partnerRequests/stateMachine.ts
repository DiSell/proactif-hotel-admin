import type { PartnerRequestStatus } from "./types";

/**
 * The ONLY place partner_requests.status transitions are decided — pure,
 * no DB, no side effect. Every caller (the future actions.ts, the future
 * webhook handler) must go through canTransition()/assertTransition()
 * rather than writing a new status directly, so this table stays the
 * single source of truth for what's allowed.
 *
 * "accepted" appears as an allowed target ONLY under "sent_to_partner" —
 * this is deliberate and load-bearing: accepted must always correspond to
 * an actual final confirmation coming from the partner. alternative_proposed
 * can NEVER transition directly to accepted — a guest accepting a proposed
 * alternative moves back to sent_to_partner (the acceptance is retransmitted
 * to the partner, who must still give a final confirmation) — see
 * "alternative_proposed" below.
 */
const ALLOWED_TRANSITIONS: Record<PartnerRequestStatus, readonly PartnerRequestStatus[]> = {
  draft: ["pending_confirmation"],
  pending_confirmation: ["sent_to_partner", "cancelled"],
  sent_to_partner: ["accepted", "rejected", "alternative_proposed", "cancelled"],
  // A guest accepting the alternative goes back to sent_to_partner (the
  // acceptance is retransmitted, awaiting the partner's real confirmation)
  // — never directly to accepted. A guest rejecting it cancels the request.
  alternative_proposed: ["sent_to_partner", "cancelled"],
  accepted: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: PartnerRequestStatus, to: PartnerRequestStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export interface TransitionResult {
  ok: boolean;
  error?: string;
}

/** Same rule as canTransition, but returns a reason string instead of a bare boolean — for callers that want to surface why a transition was refused. */
export function transition(from: PartnerRequestStatus, to: PartnerRequestStatus): TransitionResult {
  if (canTransition(from, to)) return { ok: true };
  return { ok: false, error: `Transition non autorisée : "${from}" → "${to}".` };
}

/** Every status that can legally reach "accepted" — used to prove structurally, not just by convention, that "sent_to_partner" is the only one. */
export function statusesThatCanReachAccepted(): PartnerRequestStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as PartnerRequestStatus[]).filter((status) => canTransition(status, "accepted"));
}

export const TERMINAL_STATUSES: readonly PartnerRequestStatus[] = ["accepted", "rejected", "cancelled"];

export function isTerminalStatus(status: PartnerRequestStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
