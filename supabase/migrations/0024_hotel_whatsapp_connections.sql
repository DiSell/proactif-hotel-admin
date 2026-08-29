-- =========================================================================
-- Proactif System — hotel_whatsapp_connections: persists the result of a
-- hotel's Meta WhatsApp Embedded Signup (src/features/whatsappIntegration/)
-- — WABA id, phone number id, connection type/status per hotel. Additive
-- only to every table already in place (0001 through 0023).
--
-- SCOPE OF THIS MIGRATION: schema + RLS + grants ONLY. Deliberately
-- creates ZERO SECURITY DEFINER RPCs — unlike partner_requests (0020) /
-- partner_request_deliveries (0023), there is currently no application
-- code that would call one: features/whatsappIntegration/actions.ts's own
-- receiveWhatsAppEmbeddedSignupCode() explicitly stops before any Meta
-- exchange or persistence (see that file's own doc comment). Inventing a
-- finalization RPC now, before the real Graph API exchange it would guard
-- exists, would mean guessing at a contract this task has no way to
-- validate — exactly what the task's own instructions forbid. Direct
-- INSERT/UPDATE/DELETE are therefore revoked from EVERY role, including
-- service_role: this table is fully write-locked until a future migration
-- adds the real finalization RPC(s) alongside the real Meta exchange code
-- (same "create or replace function in a later migration" pattern 0023
-- already used to extend apply_partner_request_command() without editing
-- 0020's own file).
--
-- SOURCE OF TRUTH FOR "active" (task section 13): the browser's own
-- postMessage from Embedded Signup is NEVER sufficient to mark a
-- connection `active` — that requires an independent SERVER-SIDE
-- validation of hotel -> WABA -> phone_number_id -> Proactif's own
-- system-user access to that WABA (the Graph API calls Meta's own
-- Embedded Signup documentation describes: fetching/validating the shared
-- WABA, assigning the Proactif system user to it, registering the phone
-- number, subscribing the app to the WABA). None of those calls exist yet
-- in this codebase — this migration only prepares the column/status this
-- future validation will eventually write into, via whichever RPC a later
-- migration introduces.
--
-- NO SECRET COLUMNS: no access_token/refresh_token/authorization_code/
-- app_secret/verify_token/system_user_token/credential/secret column
-- exists on this table, by design (task section 9) — the Embedded Signup
-- authorization code is ephemeral and is never persisted anywhere in this
-- codebase (see actions.ts's own doc comment); the system-user token that
-- will eventually send messages stays the existing SERVER-GLOBAL
-- WHATSAPP_META_ACCESS_TOKEN (src/lib/notifications/whatsapp/) — Meta's
-- own Tech Provider model lets one system-user token act on behalf of
-- MANY customer WABAs once each has granted access via Embedded Signup,
-- so no per-hotel token is needed here at all.
--
-- Idempotent: every DDL statement below is safe to re-run (IF NOT EXISTS
-- throughout). Does not modify any column/policy/grant/function from
-- 0001_init.sql through 0023_partner_request_deliveries.sql.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

create table if not exists public.hotel_whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,

  -- Meta's own external identifiers — deliberately TEXT, never bigint:
  -- these are opaque third-party ids, not something this schema should
  -- ever treat as a number to compute with.
  waba_id text not null,
  phone_number_id text not null,
  business_id text,

  connection_type text not null
    check (connection_type in ('coexistence', 'cloud_api_only')),

  status text not null default 'pending'
    check (status in ('pending', 'active', 'revoked', 'error')),

  -- The number this hotel's WhatsApp-dependent features (e.g. a future
  -- partner_request send) use BY DEFAULT once multiple numbers exist for
  -- the same hotel — see section D below for the exact uniqueness this
  -- guarantees (never more than one PRIMARY+ACTIVE row per hotel).
  is_primary boolean not null default true,

  connected_at timestamptz,
  disconnected_at timestamptz,

  -- Closed/sanitized codes only — same discipline as
  -- partner_request_deliveries.last_error_code
  -- (0023_partner_request_deliveries.sql's own column comment): NEVER a
  -- Meta response body, a token, an OAuth code, a real phone number, or
  -- any other raw/PII-carrying text.
  last_error_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Tenant-safety at the schema level, and a composite key any future
  -- child table can reference for its OWN tenant-safe composite FK — same
  -- discipline as 0020/0023's own hotel_partners_id_hotel_id_key /
  -- partner_requests_id_hotel_id_key / partner_request_deliveries_id_hotel_id_key.
  constraint hotel_whatsapp_connections_id_hotel_id_key unique (id, hotel_id),

  -- A given Meta phone_number_id can NEVER belong to more than one row,
  -- full stop — not partial, not scoped to "active" rows only. Two
  -- different hotels must never share a number, and re-onboarding the
  -- SAME number for the SAME hotel updates this same row rather than
  -- inserting a duplicate. waba_id is deliberately NEVER made unique on
  -- its own — a single WABA can legitimately carry several phone numbers.
  constraint hotel_whatsapp_connections_phone_number_id_key unique (phone_number_id)
);

comment on table public.hotel_whatsapp_connections is
  'One row per WhatsApp Cloud API number connected to a hotel via Meta Embedded Signup (0024). NEVER the source of truth for whether messages can actually be sent — see this migration''s own header comment on "active" requiring independent server-side validation, never the browser''s own postMessage alone. Write-locked for every role (including service_role) until a future migration adds the real finalization RPC(s) alongside the Meta Graph API exchange code that does not exist yet in this codebase.';

comment on column public.hotel_whatsapp_connections.status is
  'pending -> onboarding received from Meta but server-side finalization not yet completed. active -> WABA/phone_number_id independently validated server-side AND Proactif''s own system-user access to that WABA confirmed — NEVER set from a browser postMessage alone. revoked -> connection withdrawn/revoked. error -> finalization certainly failed.';

comment on column public.hotel_whatsapp_connections.connection_type is
  'coexistence: Meta''s own documented FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING path (the existing WhatsApp Business App number keeps working on the phone AND becomes usable via the Cloud API). cloud_api_only: a fresh WABA/number with no prior app registration to coexist with. FINISH_OBO_MIGRATION is deliberately NEVER recorded as coexistence here — see features/whatsappIntegration/embeddedSignupMessage.ts''s own isSafeFinishEvent(), which already refuses to surface that event as any kind of success in the UI.';

comment on column public.hotel_whatsapp_connections.is_primary is
  'The number this hotel''s WhatsApp features use by default once more than one connection exists for the same hotel. See hotel_whatsapp_connections_primary_active_key below for the exact guarantee this provides (at most one active+primary row per hotel) — multiple ACTIVE, non-primary connections for the same hotel are deliberately NOT restricted, to leave room for a genuine multi-number future.';

create index if not exists hotel_whatsapp_connections_hotel_id_idx on public.hotel_whatsapp_connections (hotel_id);

-- At most ONE primary, active connection per hotel — the default-send
-- number is always unambiguous. Deliberately does NOT restrict how many
-- additional active-but-not-primary connections a hotel may have (task
-- section 7: "ne crée pas une contrainte interdisant plusieurs lignes
-- active non primaires").
create unique index if not exists hotel_whatsapp_connections_primary_active_key
  on public.hotel_whatsapp_connections (hotel_id)
  where status = 'active' and is_primary = true;

comment on index public.hotel_whatsapp_connections_primary_active_key is
  'At most one active+primary WhatsApp connection per hotel — the unambiguous default-send number once this table has a real writer. Non-primary active connections, and any number of pending/revoked/error rows, are never restricted by this index.';

-- Reuses the existing shared trigger function from 0001_init.sql — same
-- pattern already used for hotels/hotel_partners/partner_requests/
-- partner_request_deliveries, no new mechanism introduced.
create trigger set_updated_at before update on public.hotel_whatsapp_connections
  for each row execute function public.set_updated_at();

alter table public.hotel_whatsapp_connections enable row level security;

create policy "superadmin can select hotel_whatsapp_connections" on public.hotel_whatsapp_connections
  for select using (public.is_superadmin());

create policy "hotel_admin can select own hotel_whatsapp_connections" on public.hotel_whatsapp_connections
  for select using (public.is_hotel_admin_for(hotel_id));

-- Deliberately NO insert/update/delete policy at all, for any role — see
-- this migration's own header comment on why: there is no RPC yet for any
-- policy to meaningfully gate, and a hotel_admin must never be able to
-- self-declare their own connection `active` via a direct write regardless
-- of policy shape.

grant select on public.hotel_whatsapp_connections to authenticated;
revoke insert, update, delete on public.hotel_whatsapp_connections from authenticated;

grant select on public.hotel_whatsapp_connections to service_role;
revoke insert, update, delete on public.hotel_whatsapp_connections from service_role;

revoke all on public.hotel_whatsapp_connections from anon;
