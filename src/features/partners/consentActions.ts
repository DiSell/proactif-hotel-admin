"use server";

// Deliberately SEPARATE from actions.ts — every export in that file is
// guarded by requireHotelAccess(hotelId, scope) (an authenticated
// superadmin or hotel_admin). The two actions here are the opposite: they
// are called from the PUBLIC confirmation page
// (src/app/partenaires/consentement/page.tsx) by an anonymous partner who
// has no session at all — the token itself IS the authorization (same
// principle as a Supabase Auth magic link), so these never call
// requireHotelAccess/requireClientAccess/requireSuperadmin, and they write
// through the service-role client, never a session-bound one — see
// 0017_hotel_partner_consent.sql's grant comment for exactly why
// service_role needed a new, narrowly column-scoped UPDATE grant for this.
import { createAdminClient } from "@/lib/supabase/admin";
import { hashConsentToken } from "./consentToken";
import type { ActionResult } from "@/lib/actionResult";

const MAX_OPENING_HOURS_CHARS = 300; // matches hotel_partners.opening_hours' own CHECK constraint (0018_hotel_partner_opening_hours.sql)
const MAX_ADDRESS_CHARS = 300; // matches hotelPartnerSchema's own address limit (features/partners/schema.ts)

interface PartnerSuppliedFields {
  openingHours: string | null;
  address: string | null;
}

async function respondToConsent(token: string, status: "accepted" | "declined", supplied: PartnerSuppliedFields): Promise<ActionResult<null>> {
  const tokenHash = hashConsentToken(token);
  const supabase = createAdminClient();

  const trimmedOpeningHours = supplied.openingHours?.trim() || null;
  const trimmedAddress = supplied.address?.trim() || null;

  // Scoped by BOTH the token hash AND consent_status = 'pending' — a
  // response can only ever be recorded once. A second click on the same
  // (or a stale, previously-emailed) link updates zero rows here, never
  // overwrites an answer already given — see the migration's own comment
  // on why consent_token_hash is deliberately never cleared afterward.
  const { data, error } = await supabase
    .from("hotel_partners")
    .update({
      consent_status: status,
      consent_responded_at: new Date().toISOString(),
      // Only ever written when the PARTNER supplies a non-empty value while
      // accepting (acceptPartnerConsent) — omitted (undefined) on decline,
      // and omitted whenever a field was left blank, so an existing
      // hotel-entered value is never wiped out by a partner submitting the
      // form with it cleared. See 0018_hotel_partner_opening_hours.sql and
      // 0019_hotel_partner_consent_address_grant.sql's own comments on why
      // the partner gets a second chance to fill these in — notably when
      // the hotel's "Générer depuis le site web" found nothing to extract
      // (e.g. a JavaScript-rendered site with no static HTML content).
      ...(trimmedOpeningHours ? { opening_hours: trimmedOpeningHours.slice(0, MAX_OPENING_HOURS_CHARS) } : null),
      ...(trimmedAddress ? { address: trimmedAddress.slice(0, MAX_ADDRESS_CHARS) } : null),
    })
    .eq("consent_token_hash", tokenHash)
    .eq("consent_status", "pending")
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("respondToConsent: update failed", { message: error.message });
    return { ok: false, error: "Impossible d'enregistrer votre réponse pour le moment." };
  }
  if (!data) {
    return { ok: false, error: "Ce lien est invalide ou vous avez déjà répondu à cette demande." };
  }

  return { ok: true, data: null };
}

/**
 * `openingHours`/`address`: optional, filled in by the partner themselves at
 * consent time — see 0018_hotel_partner_opening_hours.sql and
 * 0019_hotel_partner_consent_address_grant.sql's own comments. Never
 * overwrites an existing value with blank.
 */
export async function acceptPartnerConsent(token: string, openingHours?: string, address?: string): Promise<ActionResult<null>> {
  return respondToConsent(token, "accepted", { openingHours: openingHours ?? null, address: address ?? null });
}

export async function declinePartnerConsent(token: string): Promise<ActionResult<null>> {
  return respondToConsent(token, "declined", { openingHours: null, address: null });
}

/**
 * DISTINCT from respondToConsent/acceptPartnerConsent/declinePartnerConsent
 * above — this responds to the SEPARATE transactional WhatsApp consent
 * (0022_partner_transactional_consent.sql), scoped by
 * whatsapp_consent_token_hash/whatsapp_consent_status, never
 * consent_token_hash/consent_status. No opening_hours/address fields here —
 * this consent has nothing to do with the partner's public listing details.
 */
async function respondToTransactionalConsent(token: string, status: "accepted" | "declined"): Promise<ActionResult<null>> {
  const tokenHash = hashConsentToken(token);
  const supabase = createAdminClient();

  // Scoped by BOTH the token hash AND whatsapp_consent_status = 'pending' —
  // same "answer once, never overwritten by a replay" discipline as
  // respondToConsent above.
  const { data, error } = await supabase
    .from("hotel_partners")
    .update({
      whatsapp_consent_status: status,
      whatsapp_consent_responded_at: new Date().toISOString(),
    })
    .eq("whatsapp_consent_token_hash", tokenHash)
    .eq("whatsapp_consent_status", "pending")
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("respondToTransactionalConsent: update failed", { message: error.message });
    return { ok: false, error: "Impossible d'enregistrer votre réponse pour le moment." };
  }
  if (!data) {
    return { ok: false, error: "Ce lien est invalide ou vous avez déjà répondu à cette demande." };
  }

  return { ok: true, data: null };
}

export async function acceptPartnerTransactionalConsent(token: string): Promise<ActionResult<null>> {
  return respondToTransactionalConsent(token, "accepted");
}

export async function declinePartnerTransactionalConsent(token: string): Promise<ActionResult<null>> {
  return respondToTransactionalConsent(token, "declined");
}
