import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSmsProvider } from "./provider";
import type { SmsProvider, SmsSendResult } from "./types";

/**
 * SMS content builder + multi-recipient sender for the human-handover
 * (callback-request) chatbot flow — mirrors sendPartnerRequestSms.ts's own
 * "PREPARE (no network, pure validation/dedup) / SEND (the one place a
 * message actually leaves this server)" split, extended for 1-3 independent
 * recipients instead of one. Small helpers (E164_PATTERN, hotel-name lookup)
 * are DUPLICATED here rather than imported from sendPartnerRequestSms.ts —
 * same "the two must stay independent, no real cost to a few duplicated
 * lines" precedent already established in this codebase (see that file's own
 * header comment) — this file makes ZERO changes to sendPartnerRequestSms.ts,
 * sendSpaBookingApprovalSms.ts, or twilioSmsProvider.ts.
 */

const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const MAX_RECIPIENTS = 3;
/** Keeps the SMS body reasonably short — the full message is always preserved unabridged in hotel_service_requests.guest_message; only the SMS excerpt is capped. */
const MAX_SMS_MESSAGE_EXCERPT = 300;

export type PrepareServiceRequestSmsError = "hotel_not_found" | "no_recipient_configured";

export interface PreparedServiceRequestSms {
  hotelName: string;
  /** Deduplicated, validated E.164, capped at MAX_RECIPIENTS — see dedupRecipients below. Never empty (prepare fails with no_recipient_configured otherwise). */
  recipients: string[];
  guestPhoneE164: string;
  guestName: string | null;
  roomNumber: string | null;
  guestMessage: string;
}

export interface PrepareServiceRequestSmsInput {
  hotelId: string;
  guestPhoneE164: string;
  guestName: string | null;
  roomNumber: string | null;
  guestMessage: string;
  /** As read straight from chatbot_settings (handover_sms_phone_primary/secondary/backup) — null/empty/duplicate values are all handled here, never by the caller. */
  configuredPhones: (string | null | undefined)[];
  supabase?: SupabaseClient;
}

export type PrepareServiceRequestSmsResult = { ok: true; prepared: PreparedServiceRequestSms } | { ok: false; error: PrepareServiceRequestSmsError };

/**
 * Removes empty values, validates E.164 format, deduplicates, and caps at
 * MAX_RECIPIENTS — see this chantier's own spec, section 9. An invalid or
 * malformed configured value is silently dropped (never sent to, never
 * surfaces as an error to the guest): the back-office form already enforces
 * E.164 formatting on save (see features/assistant/schema.ts), so this is a
 * defensive floor, not the primary validation.
 */
function dedupRecipients(phones: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of phones) {
    const trimmed = raw?.trim();
    if (!trimmed || !E164_PATTERN.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= MAX_RECIPIENTS) break;
  }
  return result;
}

async function getHotelName(hotelId: string, supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase.from("hotels").select("name").eq("id", hotelId).maybeSingle<{ name: string }>();
  if (error) throw new Error(error.message);
  return data?.name ?? null;
}

/** All validation/dedup + the business facts the SMS will contain — NO network call. */
export async function prepareServiceRequestSms(input: PrepareServiceRequestSmsInput): Promise<PrepareServiceRequestSmsResult> {
  const supabase = input.supabase ?? createAdminClient();

  const hotelName = await getHotelName(input.hotelId, supabase);
  if (!hotelName) return { ok: false, error: "hotel_not_found" };

  const recipients = dedupRecipients(input.configuredPhones);
  if (recipients.length === 0) return { ok: false, error: "no_recipient_configured" };

  return {
    ok: true,
    prepared: {
      hotelName,
      recipients,
      guestPhoneE164: input.guestPhoneE164,
      guestName: input.guestName,
      roomNumber: input.roomNumber,
      guestMessage: input.guestMessage,
    },
  };
}

function truncateForSms(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SMS_MESSAGE_EXCERPT) return trimmed;
  return `${trimmed.slice(0, MAX_SMS_MESSAGE_EXCERPT - 1)}…`;
}

/**
 * Pure text construction — exact templates from this chantier's own spec
 * (section 10): the "Chambre" line only ever appears when a room number is
 * actually known (never a literal "null"/"undefined"), same discipline for
 * "Client". Identical body sent to every recipient this turn — never
 * personalized per number.
 */
export function buildServiceRequestSmsBody(prepared: PreparedServiceRequestSms): string {
  const lines = [`Demande de contact — ${prepared.hotelName}`];
  if (prepared.guestName) lines.push(`Client : ${prepared.guestName}`);
  lines.push(`Téléphone : ${prepared.guestPhoneE164}`);
  if (prepared.roomNumber) lines.push(`Chambre : ${prepared.roomNumber}`);
  lines.push(`Message : ${truncateForSms(prepared.guestMessage)}`);
  return lines.join("\n");
}

export interface ServiceRequestSmsRecipientResult {
  toE164: string;
  result: SmsSendResult;
}

export interface SendPreparedServiceRequestSmsDeps {
  provider?: SmsProvider;
}

/**
 * The ONLY place a service-request SMS actually leaves this server — one
 * independent attempt per recipient, sequential (never parallel: keeps
 * per-recipient provider errors trivially attributable and avoids any
 * shared-state race in a test double). A failure on one recipient never
 * stops the others — see this chantier's own spec, section 9's own example
 * (num1 success, num2 fail, num3 success => still "transmitted" overall).
 */
export async function sendPreparedServiceRequestSms(
  prepared: PreparedServiceRequestSms,
  deps: SendPreparedServiceRequestSmsDeps = {}
): Promise<ServiceRequestSmsRecipientResult[]> {
  const provider = deps.provider ?? getSmsProvider();
  const body = buildServiceRequestSmsBody(prepared);
  const results: ServiceRequestSmsRecipientResult[] = [];
  for (const toE164 of prepared.recipients) {
    const result = await provider.sendSms({ toE164, body });
    results.push({ toE164, result });
  }
  return results;
}
