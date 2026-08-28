-- =========================================================================
-- Proactif System — Partner consent (blocking) for chatbot recommendations.
--
-- Additive only. Does not modify any table/policy/grant from 0001_init.sql
-- through 0016_rag_freshness.sql beyond the new columns/index/grant below.
--
-- Product intent: a partner listed by a hotel must explicitly consent
-- before the chatbot is allowed to recommend them — is_active alone
-- (0015_hotel_partners.sql) is no longer sufficient; features/rag/partners.ts's
-- loadActiveHotelPartners() additionally filters on consent_status =
-- 'accepted'. The partner has no auth.users row (they are never a login-
-- capable account in this app), so this cannot reuse
-- admin.auth.admin.generateLink()/verifyOtp() — it needs its own
-- lightweight, single-purpose token, generated/validated in
-- features/partners/consentToken.ts.
--
-- consent_token_hash stores a SHA-256 hash of the token, never the token
-- itself — same discipline as every other secret in this codebase. The
-- plaintext token exists only in the emailed URL, never persisted.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

alter table public.hotel_partners
  add column email text,
  add column consent_status text not null default 'not_requested'
    check (consent_status in ('not_requested', 'pending', 'accepted', 'declined')),
  add column consent_token_hash text,
  add column consent_requested_at timestamptz,
  add column consent_responded_at timestamptz;

alter table public.hotel_partners
  add constraint hotel_partners_email_length check (email is null or char_length(email) <= 320);

comment on column public.hotel_partners.email is
  'Partner contact email, used only to send the consent request (features/partners/actions.ts::requestPartnerConsent*). Optional — a partner without an email simply cannot have a consent request sent yet.';
comment on column public.hotel_partners.consent_status is
  'not_requested (default) -> pending (email sent, awaiting response) -> accepted | declined. Read by features/rag/partners.ts::loadActiveHotelPartners(), which requires accepted (in addition to is_active) before the chatbot may ever recommend this partner.';
comment on column public.hotel_partners.consent_token_hash is
  'SHA-256 hash of the single-use consent token embedded in the emailed confirmation link (features/partners/consentToken.ts). NULL once never requested. Not cleared on response (harmless: the confirmation actions only ever act on rows still in status ''pending'', so a stale hash can never be replayed to change an already-accepted/declined answer).';

-- Serves the public confirmation page's lookup (features/partners/consentToken.ts
-- callers): find the one row matching a given token hash. Partial (WHERE
-- consent_token_hash IS NOT NULL) so the many rows that never requested
-- consent don't bloat it.
create unique index hotel_partners_consent_token_hash_key
  on public.hotel_partners (consent_token_hash)
  where consent_token_hash is not null;

-- =========================================================================
-- Grant — narrowly COLUMN-scoped UPDATE for service_role, additive to the
-- SELECT-only grant service_role already had (0015_hotel_partners.sql).
-- Required because the public confirmation page (src/app/partenaires/consentement)
-- has no session at all (an anonymous partner, not a logged-in hotel_admin/
-- superadmin) — same posture as the public widget routes
-- (0009_widget_service_role_permissions.sql): authorize via the token
-- itself, then write through service_role. The hotel-side request flow
-- (requestPartnerConsentBackoffice/Client) is unaffected — it already
-- writes through the session-bound RLS client like every other
-- hotel_partners write, no new grant needed for that path.
-- =========================================================================
grant update (consent_status, consent_responded_at, consent_token_hash) on public.hotel_partners to service_role;
