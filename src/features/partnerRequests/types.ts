/**
 * Mirrors supabase/migrations/0020_partner_requests.sql field-for-field —
 * the partner_requests/partner_request_events tables, the closed
 * event_type/actor_type vocabularies, and the command vocabulary accepted
 * by the apply_partner_request_command() RPC all match this migration
 * exactly (already applied and validated against a real Supabase project
 * — see PartnerRequestCommand below). partner_delivery_ambiguous was added
 * later, via 0023_partner_request_deliveries.sql's own `create or replace`
 * of that same function — 0020 itself was never edited (see that
 * migration's own header comment on why/how).
 */

export type PartnerRequestStatus =
  | "draft"
  | "pending_confirmation"
  | "sent_to_partner"
  | "accepted"
  | "rejected"
  | "alternative_proposed"
  | "cancelled";

/**
 * Closed vocabulary for partner_request_events.event_type — an append-only
 * audit log, never used to compute current status (partner_requests.status
 * is the single source of truth for "where things stand right now" — see
 * the plan's "projection courante vs historique" section).
 */
export type PartnerRequestEventType =
  | "request_created"
  | "guest_confirmation_requested"
  | "guest_confirmed"
  | "sent_to_partner"
  /** Transmission attempt failed — status stays unchanged (pending_confirmation or alternative_proposed); never a path to sent_to_partner. Only partner_delivery_succeeded ever produces the "sent_to_partner" event/status. */
  | "partner_delivery_failed"
  /** A transmission attempt was MADE but its outcome could not be determined (network exception/timeout after the request left this server — Meta's acceptance cannot be excluded). Added by 0023_partner_request_deliveries.sql. Status stays unchanged — never sent_to_partner (no confirmed success), never treated as a certain failure either. */
  | "partner_delivery_ambiguous"
  | "partner_accepted"
  | "partner_rejected"
  | "partner_alternative_proposed"
  | "guest_accepted_alternative"
  | "guest_rejected_alternative"
  | "guest_notification_sent"
  | "guest_notification_failed"
  | "cancelled";

export type PartnerRequestActorType = "guest" | "partner" | "hotel" | "system";

/**
 * The ONLY vocabulary apply_partner_request_command() (the RPC —
 * 0020_partner_requests.sql section G) accepts as `p_command`. The RPC
 * itself derives event_type/actor_type/the resulting status from this
 * value server-side — no caller, anywhere in this codebase, may ever pass
 * event_type/actor_type/a target status directly (see
 * features/partnerRequests/actions.ts's own doc comment).
 */
export type PartnerRequestCommand =
  | "request_guest_confirmation"
  | "guest_confirm"
  | "partner_delivery_succeeded"
  | "partner_delivery_failed"
  /** Added by 0023_partner_request_deliveries.sql — see PartnerRequestEventType's own doc comment on the matching event. */
  | "partner_delivery_ambiguous"
  | "partner_accept"
  | "partner_reject"
  | "partner_propose_alternative"
  | "guest_accept_alternative"
  | "guest_reject_alternative"
  | "guest_notification_succeeded"
  | "guest_notification_failed"
  | "cancel_by_guest"
  | "cancel_by_hotel"
  | "cancel_by_system";

/**
 * Row shape of public.partner_requests (0020_partner_requests.sql section C)
 * — the current-state projection. Deliberately colocated here rather than
 * in src/types/database.ts: this table is scoped entirely to this feature,
 * unlike Hotel/HotelPartner which predate this module and are shared much
 * more broadly. Never written directly by application code — see
 * features/partnerRequests/actions.ts's own doc comment: every write goes
 * through create_partner_request()/apply_partner_request_command().
 */
export interface PartnerRequest {
  id: string;
  hotel_id: string;
  partner_id: string;
  conversation_id: string;
  /** PII (guest's name) — unlike guest_phone_e164, currently selected by every read in queries.ts (no dedicated redaction/exclusion rule exists for it), but that does not make it non-personal data: still avoid logging it unnecessarily and never inject it into a RAG prompt beyond what this feature's own flow already requires. */
  guest_name: string | null;
  /** PII (guest's phone number) — see features/partnerRequests/queries.ts's own doc comment on when this column is (and is not) selected. */
  guest_phone_e164: string | null;
  request_category: string;
  requested_date: string | null;
  requested_time: string | null;
  party_size: number | null;
  details: string | null;
  status: PartnerRequestStatus;
  partner_response: string | null;
  responded_at: string | null;
  guest_notification_status: "pending" | "sent" | "failed";
  guest_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape of public.partner_request_events (0020_partner_requests.sql section D) — append-only audit log, never the source of "current status" (PartnerRequest.status is). */
export interface PartnerRequestEvent {
  id: string;
  hotel_id: string;
  partner_request_id: string;
  event_type: PartnerRequestEventType;
  actor_type: PartnerRequestActorType;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/**
 * The three commands a partner's own WhatsApp button tap can ever produce
 * — a TYPE ERROR, not just a convention, to ever resolve any other command
 * (e.g. partner_delivery_succeeded, cancel_by_hotel) from an inbound reply.
 * Moved here (out of the WhatsApp transport layer) once reply tokens
 * became opaque (0023_partner_request_deliveries.sql) — they no longer
 * encode a command themselves, so this is purely a domain-level type now.
 */
export type PartnerReplyCommand = Extract<PartnerRequestCommand, "partner_accept" | "partner_reject" | "partner_propose_alternative">;

/** Row shape of public.partner_request_deliveries (0023_partner_request_deliveries.sql) — one row per WhatsApp transmission ATTEMPT, never the source of truth for the business status (PartnerRequest.status is). */
export type PartnerRequestDeliveryStatus = "queued" | "sending" | "sent" | "failed" | "unknown";

/** initial_request: the first time this request is sent to the partner. alternative_acceptance: retransmitting the guest's acceptance of a partner-proposed alternative — see 0020's own comment on guest_accept_alternative never moving status directly to sent_to_partner. */
export type PartnerRequestDeliveryPurpose = "initial_request" | "alternative_acceptance";

/**
 * Deliberately EXCLUDES accept_reply_token_hash/reject_reply_token_hash/
 * propose_alternative_token_hash — same "never even in the TS type"
 * discipline as consent_token_hash/whatsapp_consent_token_hash
 * (src/types/database.ts) — these must never reach a Client Component even
 * as a hash.
 */
export interface PartnerRequestDelivery {
  id: string;
  hotel_id: string;
  partner_request_id: string;
  provider: string;
  purpose: PartnerRequestDeliveryPurpose;
  status: PartnerRequestDeliveryStatus;
  provider_message_id: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
}
