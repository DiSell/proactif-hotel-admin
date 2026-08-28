import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import type { PartnerRequestCommand } from "./types";
import { getActivePartnerRequestForConversation } from "./queries";

/**
 * Internal server-only layer the chatbot (features/rag/partnerRequestFlow.ts)
 * uses to reach the two SECURITY DEFINER RPCs already validated against a
 * real Supabase project (0020_partner_requests.sql) — NOT a Server Action
 * (no "use server" pragma), never imported by a Client Component, never
 * reachable from the browser. Defaults to createAdminClient() (service_role)
 * so the chatbot never depends on a hotel_admin/superadmin session existing
 * — a public widget visitor has none — while still accepting an injected
 * client for tests. Calls ONLY these two RPCs: no direct INSERT/UPDATE on
 * partner_requests/partner_request_events anywhere in this file, matching
 * every other caller in this codebase (features/partnerRequests/actions.ts).
 */

export interface CreatePartnerRequestForChatbotParams {
  hotelId: string;
  partnerId: string;
  conversationId: string;
  guestName: string | null;
  /** Already-normalized E.164, or null — never a raw/unvalidated string. See features/partnerRequests/phoneRedaction.ts. */
  guestPhoneE164: string | null;
  requestCategory: string;
  requestedDate: string | null;
  requestedTime: string | null;
  partySize: number | null;
  details: string | null;
}

/**
 * Idempotent by BEHAVIOR, not by an idempotency key: the actual guarantee
 * is the DB-level partial unique index on (hotel_id, conversation_id)
 * scoped to active statuses (0021_partner_requests_active_idempotency.sql)
 * — two concurrent turns for the same conversation can both pass an
 * application-level "no active request yet" check before either commits;
 * Postgres itself rejects the second INSERT with 23505. On that specific
 * error, this function re-reads the projection (the source of truth after
 * any racy/ambiguous write) and reuses whatever request is now active,
 * instead of surfacing a technical error or attempting a second create.
 * A 23505 that does NOT correspond to an active request existing on
 * re-read is NOT assumed to be this guarantee — it is never masked, and
 * still throws.
 */
export async function createPartnerRequestForChatbot(
  params: CreatePartnerRequestForChatbotParams,
  supabase: SupabaseClient = createAdminClient()
): Promise<string> {
  const { data, error } = await supabase.rpc("create_partner_request", {
    p_hotel_id: params.hotelId,
    p_partner_id: params.partnerId,
    p_conversation_id: params.conversationId,
    p_guest_name: params.guestName,
    p_guest_phone_e164: params.guestPhoneE164,
    p_request_category: params.requestCategory,
    p_requested_date: params.requestedDate,
    p_requested_time: params.requestedTime,
    p_party_size: params.partySize,
    p_details: params.details,
  });

  if (error) {
    if (error.code === "23505") {
      const active = await getActivePartnerRequestForConversation(params.hotelId, params.conversationId, supabase);
      if (active) return active.id;
    }
    throw new Error(error.message);
  }

  return data as string;
}

/**
 * Structurally narrower than the full PartnerRequestCommand vocabulary — a
 * TYPE ERROR, not just a convention, to ever pass
 * partner_delivery_succeeded/partner_delivery_failed or any other command
 * through this chatbot-facing function. This phase never transmits
 * anything to a partner (no WhatsApp/provider wired up yet), so the
 * chatbot must be structurally incapable of calling those commands.
 */
export type ChatbotPartnerRequestCommand = Extract<PartnerRequestCommand, "request_guest_confirmation" | "guest_confirm">;

export async function applyPartnerRequestCommandForChatbot(
  partnerRequestId: string,
  hotelId: string,
  command: ChatbotPartnerRequestCommand,
  supabase: SupabaseClient = createAdminClient()
): Promise<void> {
  const { error } = await supabase.rpc("apply_partner_request_command", {
    p_partner_request_id: partnerRequestId,
    p_hotel_id: hotelId,
    p_command: command,
    p_message: null,
    p_metadata: null,
  });
  if (error) throw new Error(error.message);
}
