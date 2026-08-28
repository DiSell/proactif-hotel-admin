-- =========================================================================
-- Proactif System — Transactional WhatsApp consent, DISTINCT from the
-- existing chatbot-recommendation consent (0017_hotel_partner_consent.sql).
--
-- WHY A NEW MIGRATION, NOT A REUSE OF 0017/0019:
-- 0017 introduced consent_status/consent_token_hash/consent_requested_at/
-- consent_responded_at as single-purpose, hardcoded COLUMNS directly on
-- hotel_partners — not a generic, reusable "consent grant" model (no grants
-- table, no grant-type column, no polymorphic key). 0019 only ADDED a
-- narrower column-scoped UPDATE grant (the `address` column) to the SAME
-- single-purpose mechanism; it introduces no reusable abstraction either.
-- There is therefore nothing generic to extend — this migration mirrors
-- 0017's exact pattern (parallel columns, same discipline) for a SECOND,
-- independent consent type, rather than inventing a different, competing
-- mechanism. Same token infrastructure (features/partners/consentToken.ts)
-- is reused as-is — it was already type-agnostic (pure token generation/
-- hashing, no reference to any specific column).
--
-- PRODUCT INTENT: recommendation consent ("may Camille recommend you?") and
-- transactional consent ("may we forward client requests to your WhatsApp
-- number?") are independent authorizations. Accepting one is NEVER
-- interpreted as accepting the other — see the explicit non-backfill
-- guarantee below.
--
-- Additive only. Does not modify any column/policy/grant from 0001_init.sql
-- through 0021_partner_requests_active_idempotency.sql beyond the new
-- columns/index/grant below. Idempotent: every statement below is safe to
-- re-run (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, GRANT is
-- naturally idempotent).
--
-- NO BACKFILL: every existing hotel_partners row gets whatsapp_consent_status
-- = 'not_requested' purely via the column DEFAULT — there is deliberately no
-- UPDATE statement anywhere in this migration that could set it to
-- 'accepted' for any existing row, regardless of that row's current
-- (unrelated) consent_status value.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

alter table public.hotel_partners
  add column if not exists whatsapp_consent_status text not null default 'not_requested'
    check (whatsapp_consent_status in ('not_requested', 'pending', 'accepted', 'declined')),
  add column if not exists whatsapp_consent_token_hash text,
  add column if not exists whatsapp_consent_requested_at timestamptz,
  add column if not exists whatsapp_consent_responded_at timestamptz;

comment on column public.hotel_partners.whatsapp_consent_status is
  'Independent from consent_status (0017_hotel_partner_consent.sql), which only governs chatbot-recommendation eligibility. not_requested (default) -> pending (email sent, awaiting response) -> accepted | declined. Governs whether this partner may LATER receive a transactional WhatsApp request (features/partners/canReceivePartnerRequests.ts) — no message is ever sent as part of this migration or the code introduced alongside it. Accepting the chatbot-recommendation consent never implies accepting this one, and vice versa.';
comment on column public.hotel_partners.whatsapp_consent_token_hash is
  'SHA-256 hash of the single-use transactional-consent token embedded in the emailed confirmation link (features/partners/consentToken.ts — same generic token module as consent_token_hash, reused as-is). NULL until first requested. Never cleared on response, same reasoning as consent_token_hash: the confirmation actions only ever act on rows still in whatsapp_consent_status = ''pending''.';
comment on column public.hotel_partners.whatsapp_consent_requested_at is
  'When the transactional-consent request was last sent — audit trail, independent of consent_requested_at.';
comment on column public.hotel_partners.whatsapp_consent_responded_at is
  'When the partner last responded to the transactional-consent request — audit trail, independent of consent_responded_at.';

-- Serves the public confirmation page's lookup (features/partners/consentLookup.ts::
-- getPartnerTransactionalConsentRequest): find the one row matching a given
-- token hash. Partial (WHERE ... IS NOT NULL) so the many rows that never
-- requested this consent don't bloat it — same shape as
-- hotel_partners_consent_token_hash_key (0017_hotel_partner_consent.sql).
-- A SEPARATE index from that one: the two token hashes live in different
-- columns and are never compared against each other, so a recommendation
-- token can never resolve a transactional-consent lookup or vice versa.
create unique index if not exists hotel_partners_whatsapp_consent_token_hash_key
  on public.hotel_partners (whatsapp_consent_token_hash)
  where whatsapp_consent_token_hash is not null;

-- =========================================================================
-- Grant — narrowly COLUMN-scoped UPDATE for service_role, additive to the
-- grants service_role already has (0015_hotel_partners.sql SELECT,
-- 0017/0019 UPDATE on the recommendation-consent columns + address).
-- Required for the exact same reason as 0017's own grant: the public
-- confirmation page has no session at all (an anonymous partner) — the
-- token itself is the authorization, then the write goes through
-- service_role. The hotel-side request flow
-- (requestPartnerTransactionalConsentBackoffice/Client) is unaffected — it
-- already writes through the session-bound RLS client like every other
-- hotel_partners write, no new grant needed for that path.
-- =========================================================================
grant update (whatsapp_consent_status, whatsapp_consent_responded_at, whatsapp_consent_token_hash) on public.hotel_partners to service_role;
