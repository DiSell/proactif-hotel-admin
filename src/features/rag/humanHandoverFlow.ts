import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  prepareServiceRequestSms,
  sendPreparedServiceRequestSms,
  type ServiceRequestSmsRecipientResult,
} from "@/lib/notifications/sms/sendServiceRequestSms";
import type { SmsProvider, SmsSendResult } from "@/lib/notifications/sms/types";

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — the orchestration a widget-form
 * phone submission runs, mirroring partnerRequestFlow.ts's own
 * submitStructuredGuestPhone in shape (create -> notify -> return a message
 * the widget shows verbatim), but deliberately a SEPARATE module: this
 * chantier's own spec explicitly forbids coupling handover to partnerRequests
 * (see this file's own tests for confirmation none of that module is
 * imported here). No LLM call anywhere in this file — every branch is
 * server-decided, per this chantier's own "sans hallucination LLM" rule.
 */

interface HandoverChatbotSettingsRow {
  handover_sms_phone_primary: string | null;
  handover_sms_phone_secondary: string | null;
  handover_sms_phone_backup: string | null;
  handoff_phone: string | null;
  handoff_email: string | null;
}

export interface SubmitHandoverPhoneParams {
  hotelId: string;
  conversationId: string;
  /** Already normalized to E.164 by the caller (route.ts), same discipline as submitStructuredGuestPhone. */
  phoneE164: string;
  /** The triggering message, verbatim — never re-summarized by an LLM (section 4: "sans hallucination LLM"). */
  guestMessage: string;
  /** Free text the visitor typed into the widget's optional room field — never invented, never looked up. */
  roomNumber: string | null;
  supabase?: SupabaseClient;
  /** Test/DI seam only — production always resolves getSmsProvider() itself (see sendServiceRequestSms.ts). Never a real Twilio call in a test. */
  smsProvider?: SmsProvider;
}

export type SubmitHandoverPhoneResult = { ok: true; message: string } | { ok: false; error: string };

export type HandoverSmsOutcome = "sent" | "no_recipient_configured" | "all_failed";

interface FallbackContact {
  handoffPhone: string | null;
  handoffEmail: string | null;
}

/**
 * The exact confirmation rule from this chantier's own spec (section 12):
 * the "transmise" wording may ONLY be shown when at least one SMS is a
 * CONFIRMED success — never on a merely-attempted or unknown-outcome send.
 * Every other case uses a neutral, honest fallback, optionally pointing to
 * the pre-existing PASSIVE contact info (chatbot_settings.handoff_phone/
 * handoff_email) when configured — never a raw Twilio error, never a lie
 * about what actually happened.
 */
export function buildHandoverConfirmationMessage(outcome: HandoverSmsOutcome, fallbackContact: FallbackContact): string {
  if (outcome === "sent") {
    return "Votre demande a bien été transmise à l'établissement. Vous serez contacté dans les meilleurs délais.";
  }
  const contactParts: string[] = [];
  if (fallbackContact.handoffPhone) contactParts.push(`au ${fallbackContact.handoffPhone}`);
  if (fallbackContact.handoffEmail) contactParts.push(`par email à ${fallbackContact.handoffEmail}`);
  if (contactParts.length > 0) {
    return `Je n'ai pas pu transmettre automatiquement votre demande. Vous pouvez contacter directement l'établissement ${contactParts.join(" ou ")}.`;
  }
  return "Je n'ai pas pu transmettre automatiquement votre demande pour le moment. Merci de contacter directement l'établissement.";
}

function attemptStatus(result: SmsSendResult): "sent" | "failed" | "unknown" {
  if (result.ok) return "sent";
  if (result.error === "provider_error") return "failed";
  return "unknown"; // provider_not_configured or provider_unknown — acceptance cannot be excluded, never presented as a definite failure
}

/** Best-effort traceability write — never fails the overall flow: a lost attempt row is a minor analytics gap, not a reason to tell the guest their request failed when the SMS may well have gone out. */
async function recordAttempt(supabase: SupabaseClient, hotelId: string, serviceRequestId: string, attempt: ServiceRequestSmsRecipientResult) {
  try {
    await supabase.rpc("record_hotel_service_request_sms_attempt", {
      p_hotel_id: hotelId,
      p_service_request_id: serviceRequestId,
      p_recipient_phone_e164: attempt.toE164,
      p_status: attemptStatus(attempt.result),
    });
  } catch (err) {
    console.error("humanHandoverFlow: failed to record SMS attempt", { hotelId, message: (err as Error).message });
  }
}

/**
 * The ONLY place a chatbot visitor's handover request is created. Calls the
 * guest-safe RPC from 0048 (create_hotel_service_request_from_widget) —
 * NEVER the staff-only create_hotel_service_request/
 * require_service_request_hotel_user path (0043, untouched, unweakened).
 */
export async function submitHandoverPhone(params: SubmitHandoverPhoneParams): Promise<SubmitHandoverPhoneResult> {
  const supabase = params.supabase ?? createAdminClient();

  const { data: requestId, error: createError } = await supabase.rpc("create_hotel_service_request_from_widget", {
    p_hotel_id: params.hotelId,
    p_conversation_id: params.conversationId,
    p_guest_phone_e164: params.phoneE164,
    p_room_number: params.roomNumber,
    p_guest_message: params.guestMessage,
  });
  if (createError || !requestId) {
    console.error("humanHandoverFlow: create_hotel_service_request_from_widget failed", { hotelId: params.hotelId, message: createError?.message });
    return { ok: false, error: "Impossible d'enregistrer votre demande. Merci de réessayer." };
  }

  const { data: settingsRow } = await supabase
    .from("chatbot_settings")
    .select("handover_sms_phone_primary, handover_sms_phone_secondary, handover_sms_phone_backup, handoff_phone, handoff_email")
    .eq("hotel_id", params.hotelId)
    .maybeSingle<HandoverChatbotSettingsRow>();

  const fallbackContact: FallbackContact = {
    handoffPhone: settingsRow?.handoff_phone ?? null,
    handoffEmail: settingsRow?.handoff_email ?? null,
  };

  const prepared = await prepareServiceRequestSms({
    hotelId: params.hotelId,
    guestPhoneE164: params.phoneE164,
    guestName: null,
    roomNumber: params.roomNumber,
    guestMessage: params.guestMessage,
    configuredPhones: [
      settingsRow?.handover_sms_phone_primary,
      settingsRow?.handover_sms_phone_secondary,
      settingsRow?.handover_sms_phone_backup,
    ],
    supabase,
  });

  if (!prepared.ok) {
    // No SMS attempted at all — the request row still exists for staff to
    // find manually, but the guest is never told "transmise" here.
    return { ok: true, message: buildHandoverConfirmationMessage("no_recipient_configured", fallbackContact) };
  }

  const attempts = await sendPreparedServiceRequestSms(prepared.prepared, { provider: params.smsProvider });
  for (const attempt of attempts) {
    await recordAttempt(supabase, params.hotelId, requestId as string, attempt);
  }

  const anySent = attempts.some((attempt) => attempt.result.ok);
  return { ok: true, message: buildHandoverConfirmationMessage(anySent ? "sent" : "all_failed", fallbackContact) };
}
