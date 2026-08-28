"use server";

import { requireHotelAccess } from "@/lib/auth/session";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";
import { applyPartnerRequestCommandSchema, createPartnerRequestSchema, type ApplyPartnerRequestCommandInput, type CreatePartnerRequestInput } from "./schema";

/**
 * Every action here is guarded by requireHotelAccess(hotelId, scope) — same
 * pattern as features/partners/actions.ts — and writes through the
 * SESSION-BOUND client requireHotelAccess() resolves (never service_role):
 * apply_partner_request_command()/create_partner_request()
 * (0020_partner_requests.sql) are SECURITY DEFINER functions that check
 * `is_superadmin()`/`is_hotel_admin_for(p_hotel_id)` internally when the
 * caller isn't service_role — calling them through the RLS-gated session
 * client is exactly the intended path for back-office/client-portal
 * callers, and is a second, independent enforcement of the same tenant
 * rule requireHotelAccess() already checked.
 *
 * `scope` is NEVER a parameter on any exported Server Action below — same
 * discipline as every other scoped-action file in this codebase: a client
 * component must never be able to supply or influence which cookie scope a
 * shared action reads, even indirectly via a prop or a tampered payload.
 * Each `*Internal` function takes `scope` as a plain argument but is never
 * exported/never "use server"-callable on its own; every exported action is
 * a thin wrapper with a HARDCODED literal — "backoffice" or "client" —
 * baked in at the export itself, never received from any caller.
 *
 * Deliberately NO service_role-based variant here yet — the future
 * chatbot/notification engine will need its own internal function using
 * createAdminClient() (same posture as features/rag/chatEndpoint.ts), but
 * that path is not wired up in this pass; only the back-office/client
 * portal entrypoints exist so far.
 *
 * Neither function below ever performs a direct INSERT/UPDATE on
 * partner_requests/partner_request_events — both call ONLY the two
 * SECURITY DEFINER RPCs, matching the schema-level guarantee that no other
 * write path exists at all (0020_partner_requests.sql).
 */

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

async function createPartnerRequestInternal(input: CreatePartnerRequestInput, scope: AuthScope): Promise<ActionResult<{ id: string }>> {
  const parsed = createPartnerRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const { supabase } = await requireHotelAccess(parsed.data.hotelId, scope);

  const { data, error } = await supabase.rpc("create_partner_request", {
    p_hotel_id: parsed.data.hotelId,
    p_partner_id: parsed.data.partnerId,
    p_conversation_id: parsed.data.conversationId,
    p_guest_name: parsed.data.guestName || null,
    p_guest_phone_e164: parsed.data.guestPhoneE164 || null,
    p_request_category: parsed.data.requestCategory,
    p_requested_date: parsed.data.requestedDate || null,
    p_requested_time: parsed.data.requestedTime || null,
    p_party_size: parsed.data.partySize ?? null,
    p_details: parsed.data.details || null,
  });

  if (error) {
    // Never logs parsed.data directly — that object may carry
    // guest_phone_e164 (PII). Only the RPC's own error message (never a
    // phone number) is logged here.
    console.error("createPartnerRequest: RPC failed", { message: error.message });
    return { ok: false, error: "Impossible de créer la demande pour le moment." };
  }

  return { ok: true, data: { id: data as string } };
}

export async function createPartnerRequestBackoffice(input: CreatePartnerRequestInput): Promise<ActionResult<{ id: string }>> {
  return createPartnerRequestInternal(input, "backoffice");
}

export async function createPartnerRequestClient(input: CreatePartnerRequestInput): Promise<ActionResult<{ id: string }>> {
  return createPartnerRequestInternal(input, "client");
}

async function applyPartnerRequestCommandInternal(input: ApplyPartnerRequestCommandInput, scope: AuthScope): Promise<ActionResult<null>> {
  const parsed = applyPartnerRequestCommandSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Commande invalide.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const { supabase } = await requireHotelAccess(parsed.data.hotelId, scope);

  const { error } = await supabase.rpc("apply_partner_request_command", {
    p_partner_request_id: parsed.data.partnerRequestId,
    p_hotel_id: parsed.data.hotelId,
    p_command: parsed.data.command,
    p_message: parsed.data.message || null,
    p_metadata: parsed.data.metadata ?? null,
  });

  if (error) {
    console.error("applyPartnerRequestCommand: RPC failed", { message: error.message, command: parsed.data.command });
    return { ok: false, error: "Impossible d'appliquer cette action pour le moment." };
  }

  return { ok: true, data: null };
}

export async function applyPartnerRequestCommandBackoffice(input: ApplyPartnerRequestCommandInput): Promise<ActionResult<null>> {
  return applyPartnerRequestCommandInternal(input, "backoffice");
}

export async function applyPartnerRequestCommandClient(input: ApplyPartnerRequestCommandInput): Promise<ActionResult<null>> {
  return applyPartnerRequestCommandInternal(input, "client");
}
