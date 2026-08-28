import type { SupabaseClient } from "@supabase/supabase-js";
import type { PartnerRequest, PartnerRequestEvent, PartnerRequestStatus } from "./types";

/**
 * Session-bound, read-only queries — RLS (0020_partner_requests.sql) is the
 * real gate: "superadmin can select" / "hotel_admin can select own". These
 * functions perform NO authorization themselves, same discipline as
 * features/partners/queries.ts — callers must have already authorized
 * hotelId (via requireHotelAccess()) before calling any of these. The
 * explicit `.eq("hotel_id", hotelId)` on every query is defense in depth on
 * top of RLS, not a substitute for it.
 *
 * `supabase` is REQUIRED on every function — no default, no fallback —
 * same reasoning as features/partners/queries.ts: back-office and the
 * client portal use different session cookies, and these shared functions
 * have no way to know on their own which one a caller authenticated under.
 *
 * No write function lives here on purpose: every write to
 * partner_requests/partner_request_events goes exclusively through the two
 * SECURITY DEFINER RPCs (create_partner_request/apply_partner_request_command,
 * see features/partnerRequests/actions.ts) — there is no direct INSERT/
 * UPDATE path, at the database level, for either table.
 */

/**
 * Explicit column list — deliberately EXCLUDES guest_phone_e164, even
 * though it's not a secret the way consent_token_hash is: no current
 * caller of this function (back-office/client-portal list views) actually
 * needs the guest's raw phone number, and PII should never be selected
 * "just in case" it's useful later. A future screen that genuinely needs
 * to display/act on it should add a narrowly-scoped, separately-reviewed
 * query rather than have it ride along in this general-purpose list read.
 */
const PARTNER_REQUEST_LIST_COLUMNS =
  "id, hotel_id, partner_id, conversation_id, guest_name, request_category, requested_date, requested_time, party_size, details, status, partner_response, responded_at, guest_notification_status, guest_notified_at, created_at, updated_at";

export async function getPartnerRequestById(
  hotelId: string,
  partnerRequestId: string,
  supabase: SupabaseClient
): Promise<PartnerRequest | null> {
  const { data, error } = await supabase
    .from("partner_requests")
    .select(PARTNER_REQUEST_LIST_COLUMNS)
    .eq("id", partnerRequestId)
    .eq("hotel_id", hotelId)
    .maybeSingle<PartnerRequest>();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Narrowly-scoped, deliberate exception to the "never select
 * guest_phone_e164" discipline every other function in this file follows —
 * used ONLY by the structured phone-collection endpoint's idempotency check
 * (features/rag/partnerRequestFlow.ts:submitStructuredGuestPhone), to
 * detect a double-submit/retry of the SAME number vs. a genuinely different
 * one. The returned value must never be logged, rendered, or returned to
 * any HTTP response — it exists purely for an internal equality check.
 */
export async function getGuestPhoneForPartnerRequest(
  hotelId: string,
  partnerRequestId: string,
  supabase: SupabaseClient
): Promise<string | null> {
  const { data, error } = await supabase
    .from("partner_requests")
    .select("guest_phone_e164")
    .eq("id", partnerRequestId)
    .eq("hotel_id", hotelId)
    .maybeSingle<{ guest_phone_e164: string | null }>();
  if (error) throw new Error(error.message);
  return data?.guest_phone_e164 ?? null;
}

export async function listPartnerRequestsForHotel(hotelId: string, supabase: SupabaseClient): Promise<PartnerRequest[]> {
  const { data, error } = await supabase
    .from("partner_requests")
    .select(PARTNER_REQUEST_LIST_COLUMNS)
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false })
    .returns<PartnerRequest[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Full event history for one request — the append-only audit trail
 * (0020_partner_requests.sql section D). `partner_request_id` is scoped by
 * `hotel_id` too, same defense-in-depth reasoning as the queries above,
 * even though the composite FK already makes a cross-tenant event
 * impossible at the schema level.
 */
/** Every status that still represents an open, not-yet-resolved workflow (see stateMachine.ts's TERMINAL_STATUSES for the complement) — a conversation can have at most a practical handful of these at once, normally just one. */
const ACTIVE_PARTNER_REQUEST_STATUSES: PartnerRequestStatus[] = ["draft", "pending_confirmation", "sent_to_partner", "alternative_proposed"];

/**
 * The chatbot's own read before deciding whether to create a new
 * partner_request or progress an existing one for this conversation (see
 * features/rag/partnerRequestFlow.ts) — the most recent active request only,
 * never a resolved/cancelled one. Same PII exclusion as the functions above:
 * guest_phone_e164 is never selected, so this result is safe to hand to
 * prompt-building code that assembles model instructions.
 */
export async function getActivePartnerRequestForConversation(
  hotelId: string,
  conversationId: string,
  supabase: SupabaseClient
): Promise<PartnerRequest | null> {
  const { data, error } = await supabase
    .from("partner_requests")
    .select(PARTNER_REQUEST_LIST_COLUMNS)
    .eq("hotel_id", hotelId)
    .eq("conversation_id", conversationId)
    .in("status", ACTIVE_PARTNER_REQUEST_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<PartnerRequest>();
  if (error) throw new Error(error.message);
  return data;
}

export async function listPartnerRequestEvents(
  hotelId: string,
  partnerRequestId: string,
  supabase: SupabaseClient
): Promise<PartnerRequestEvent[]> {
  const { data, error } = await supabase
    .from("partner_request_events")
    .select("id, hotel_id, partner_request_id, event_type, actor_type, message, metadata, created_at")
    .eq("hotel_id", hotelId)
    .eq("partner_request_id", partnerRequestId)
    .order("created_at", { ascending: true })
    .returns<PartnerRequestEvent[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Narrow server-side retry check; selects no event metadata or message. */
export async function hasGuestConfirmedEvent(partnerRequestId: string, hotelId: string, supabase: SupabaseClient): Promise<boolean> {
  const { data, error } = await supabase
    .from("partner_request_events")
    .select("id")
    .eq("partner_request_id", partnerRequestId)
    .eq("hotel_id", hotelId)
    .eq("event_type", "guest_confirmed")
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(error.message);
  return data !== null;
}
