import type { HotelPartner } from "@/types/database";

/**
 * Same literal pattern as the DB CHECK constraints on
 * hotel_partners.request_phone_e164/partner_requests.guest_phone_e164
 * (0020_partner_requests.sql) and features/partnerRequests/schema.ts's own
 * E164_PATTERN — duplicated deliberately, not derived at runtime: this is a
 * pure, dependency-free eligibility check, and importing an internal schema
 * constant across features would be a worse coupling than repeating one
 * regex literal that's already documented as intentionally stable.
 */
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;

/**
 * The ONLY place this eligibility decision is computed — server-side,
 * verifiable, and reused by any FUTURE transport layer (WhatsApp or
 * otherwise) rather than re-implemented per caller. This function sends
 * NOTHING itself: it only answers "would a request to this partner be
 * allowed right now?".
 *
 * Requires ALL of:
 * - is_active: the hotel's own on/off toggle for this partner.
 * - consent_status === "accepted": the partner already agreed to be
 *   recommended by the chatbot at all (0017_hotel_partner_consent.sql) —
 *   kept as a precondition since a partner who never agreed to even being
 *   recommended has even less business receiving a transactional request.
 * - whatsapp_consent_status === "accepted": the SEPARATE, transactional
 *   WhatsApp consent (0022_partner_transactional_consent.sql) — never
 *   implied by consent_status alone, however it's set.
 * - request_phone_e164: present AND a well-formed E.164 value — the DB
 *   CHECK constraint already guarantees this for any non-null stored value,
 *   this is a defense-in-depth re-check, not a substitute for it.
 */
export function canReceivePartnerRequests(
  partner: Pick<HotelPartner, "is_active" | "consent_status" | "whatsapp_consent_status" | "request_phone_e164">
): boolean {
  if (!partner.is_active) return false;
  if (partner.consent_status !== "accepted") return false;
  if (partner.whatsapp_consent_status !== "accepted") return false;
  if (!partner.request_phone_e164) return false;
  if (!E164_PATTERN.test(partner.request_phone_e164)) return false;
  return true;
}
