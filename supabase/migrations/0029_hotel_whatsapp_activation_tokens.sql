-- =========================================================================
-- Proactif System — hotel_whatsapp_activation_tokens: opaque, single-purpose
-- links that let a hotel's WhatsApp Business owner (who has NO Proactif
-- account) complete Meta's Embedded Signup for their own establishment,
-- without ever logging into the admin dashboard or touching Meta Developers.
-- Additive only to every table already in place (0001 through 0028).
--
-- NEVER a reusable/generic token table: scoped entirely to this one
-- purpose, same "one table per concern" discipline as
-- hotel_whatsapp_connections (0024) / hotel_whatsapp_connection_secrets
-- (0026), which this table does NOT replace or modify in any way.
--
-- TOKEN DISCIPLINE (same as features/partners/consentToken.ts's own,
-- reused verbatim by src/features/whatsappIntegration/activationToken.ts):
-- the raw 256-bit token exists ONLY in the generated activation URL,
-- returned once to the admin who generated it, and once more in the URL the
-- hotel's WhatsApp owner clicks — this table stores ONLY token_hash
-- (sha256 hex, 64 chars), never the raw value. No application code ever
-- logs the raw token.
--
-- CONCURRENCY / LEASE DESIGN (the reason this table has a
-- processing_started_at column, unlike the simpler
-- consent_token_hash/consent_status columns on hotel_partners from 0017):
-- unlike a partner accepting/declining consent (a single, instantaneous DB
-- write), consuming an activation token spans a multi-step EXTERNAL flow —
-- Meta code exchange, WABA/phone_number_id verification, AES-256-GCM
-- encryption, then the 0026 RPC — during which two concurrent callbacks
-- (e.g. the link opened in two tabs) could otherwise both pass every
-- pre-check before either commits. `processing_started_at` is a lease
-- acquired via ONE atomic `UPDATE ... RETURNING` (see
-- activationTokenPersistence.ts::claimActivationToken) BEFORE any Meta call
-- is made — exactly one concurrent caller can acquire it, so exactly one
-- external flow ever runs per token at a time. The lease is released
-- (`processing_started_at = null`) if that flow fails at any step, allowing
-- a genuine retry; it is only ever paired with `used_at` becoming non-null
-- on real, complete success.
--
-- CRASH RECOVERY: `claimActivationToken` treats a lease older than 10
-- minutes as stale and reclaimable (`processing_started_at is null or
-- processing_started_at < now() - interval '10 minutes'`) — chosen because
-- every step of the finalization chain (Meta HTTP calls, encryption, one
-- RPC call) completes in well under a minute in normal operation; 10
-- minutes gives ample margin above that before assuming a crashed/hung
-- request abandoned its lease, without leaving a genuinely stuck lease
-- unrecoverable for hours. No process on this codebase currently holds a
-- lease anywhere near that long by design.
--
-- NO NEW RPC: every operation on this table (claim, release, mark-used,
-- generate, revoke-on-regenerate) is a single, conditionally-scoped
-- UPDATE/INSERT from server-only code (createAdminClient(), service_role) —
-- the same "plain conditional UPDATE is atomic enough" precedent already
-- proven by features/partners/consentActions.ts's own respondToConsent()
-- (0017/0022), not the SECURITY DEFINER RPC precedent used by
-- hotel_whatsapp_connections' own finalization (0025/0026), which remains
-- completely untouched and is still the ONLY way this table's hotel_id
-- ever reaches a real WhatsApp connection.
--
-- Idempotent: every DDL statement below is safe to re-run (IF NOT EXISTS
-- throughout). Does not modify any column/policy/grant/function from
-- 0001_init.sql through 0028_fix_whatsapp_finalization_conflict_target_ambiguity.sql.
--
-- STATUS: 0001_init.sql through 0028_fix_whatsapp_finalization_conflict_target_ambiguity.sql
-- are ALREADY APPLIED to this project's Supabase database. This file
-- (0029) is the only migration NOT yet applied as of this comment — apply
-- it on its own, through your own Supabase workflow, without replaying any
-- migration before it.
-- =========================================================================

create table if not exists public.hotel_whatsapp_activation_tokens (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,

  -- sha256 hex digest of the raw token — see this migration's own header
  -- comment on why the raw value is never persisted anywhere.
  token_hash text not null,

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,

  -- Lease acquired atomically before any external Meta call — see this
  -- migration's own header comment ("CONCURRENCY / LEASE DESIGN").
  processing_started_at timestamptz,

  -- Set ONLY after a genuine, complete success (Meta finalize + encrypt +
  -- 0026 RPC all succeeded) — never on a mere claim, never optimistically.
  used_at timestamptz,

  -- Set when an admin generates a replacement link for the same hotel
  -- (see this migration's own header comment) — never cleared afterward,
  -- never set on a token that already has used_at (a completed activation
  -- is never retroactively invalidated).
  revoked_at timestamptz,

  constraint hotel_whatsapp_activation_tokens_token_hash_key unique (token_hash),
  constraint hotel_whatsapp_activation_tokens_token_hash_length check (char_length(token_hash) = 64)
);

comment on table public.hotel_whatsapp_activation_tokens is
  'One row per generated WhatsApp activation link (src/features/whatsappIntegration/). Resolves hotel_id server-side from a hashed, opaque token — never the reverse. See this migration''s own header comment for the lease/concurrency design (processing_started_at) and why no new RPC was needed for it.';

comment on column public.hotel_whatsapp_activation_tokens.processing_started_at is
  'Lease acquired via one atomic UPDATE ... RETURNING before any Meta call is made (claimActivationToken) — prevents two concurrent callbacks for the same token both running the finalization chain. Released (set back to null) on any failure; a lease older than 10 minutes is treated as abandoned (crashed process) and may be reclaimed. Cleared alongside used_at on real success.';

comment on column public.hotel_whatsapp_activation_tokens.used_at is
  'Set ONLY after finalizeWhatsAppEmbeddedSignupForHotel() and the 0026 RPC both succeeded for this token''s hotel_id — never on a mere claim, never on a Meta cancellation/error, never on a crypto/RPC failure. A token with used_at set can never be reclaimed or reused.';

comment on column public.hotel_whatsapp_activation_tokens.revoked_at is
  'Set when an admin generates a replacement activation link for the same hotel (at most one non-used, non-revoked token per hotel at a time) — never set on a token that already has used_at.';

create index if not exists hotel_whatsapp_activation_tokens_hotel_id_idx
  on public.hotel_whatsapp_activation_tokens (hotel_id);

-- Fast lookup of "the current active link, if any" for a hotel — used both
-- by the admin status read and by the revoke-on-regenerate step. Partial on
-- purpose: used/revoked rows are historical noise for this specific lookup.
create index if not exists hotel_whatsapp_activation_tokens_hotel_active_idx
  on public.hotel_whatsapp_activation_tokens (hotel_id, created_at desc)
  where used_at is null and revoked_at is null;

-- Enforces, at the schema level, that at most one non-used, non-revoked
-- token exists per hotel at any time — the actual guarantee
-- createActivationLink's own revoke-then-insert logic is designed to
-- provide (activationTokenPersistence.ts). This index is the backstop: if
-- a race ever let two inserts through, the SECOND one fails with a unique
-- violation (23505) rather than silently leaving two active links.
create unique index if not exists hotel_whatsapp_activation_tokens_one_current_per_hotel_idx
  on public.hotel_whatsapp_activation_tokens (hotel_id)
  where used_at is null and revoked_at is null;

alter table public.hotel_whatsapp_activation_tokens enable row level security;
-- Deliberately ZERO policies, for any role — every operation on this table
-- happens exclusively through createAdminClient() (service_role) from
-- server-only code (Server Actions / a public RSC's own server-side data
-- access), never a session-scoped client. Same posture as
-- hotel_whatsapp_connection_secrets (0026): RLS enabled with no policy
-- means only the narrowly-scoped GRANTs below determine access, and
-- neither `authenticated` nor `anon` receives any.

grant select, insert on public.hotel_whatsapp_activation_tokens to service_role;
-- Column-scoped, same discipline as 0017's own
-- "grant update (consent_status, ...) to service_role": service_role may
-- only ever flip these three timestamps, never rewrite hotel_id/token_hash/
-- expires_at/created_at after insertion.
grant update (processing_started_at, used_at, revoked_at)
  on public.hotel_whatsapp_activation_tokens to service_role;

revoke insert, update, delete on public.hotel_whatsapp_activation_tokens from authenticated;
revoke all on public.hotel_whatsapp_activation_tokens from anon;
