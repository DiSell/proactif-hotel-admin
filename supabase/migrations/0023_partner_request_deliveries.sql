-- =========================================================================
-- Proactif System — partner_request_deliveries: persistent tracking of each
-- WhatsApp transmission ATTEMPT for a partner_request, plus opaque
-- reply-token correlation for the partner's own button taps. Additive only
-- to every table already in place (0015 through 0022).
--
-- WHY THIS MIGRATION EXISTS (see the design audit that preceded it):
-- the WhatsApp transport code (src/lib/notifications/whatsapp/,
-- features/partnerRequests/deliveryService.ts) was built provider-agnostic
-- and never sends a real message, but it could not yet answer two
-- questions safely:
--   1) "did we already attempt this exact send, or is this a genuine
--      retry racing a still-in-flight attempt?" — apply_partner_request_command()
--      already prevents an INCONSISTENT partner_requests.status (its own
--      row lock + status guard), but nothing previously prevented Meta
--      itself from receiving the SAME logical attempt twice after a
--      process crash/timeout that occurs AFTER Meta accepted the message
--      but BEFORE our server could record that fact.
--   2) "which partner_request does this inbound WhatsApp button tap belong
--      to, and for which command?" — the previous design (removed by this
--      migration's own application-code changes) encoded partnerRequestId/
--      hotelId/command directly into the button's payload, HMAC-signed.
--      HMAC-SIGNED IS NOT ENCRYPTED: the payload half was merely
--      base64url-encoded (trivially decodable by anyone, including Meta's
--      own infrastructure and the partner's own device) — it leaked
--      internal identifiers to a third party for no operational benefit.
--
-- This migration answers both with ONE table: a row per delivery ATTEMPT,
-- carrying its own opaque reply-token hashes. The reply tokens themselves
-- are now cryptographically random opaque strings (see
-- lib/notifications/whatsapp/replyToken.ts) carrying ZERO decodable
-- information — correlation happens exclusively via a server-side lookup
-- by SHA-256 hash against THIS table, never by decoding anything.
--
-- Deliberately does NOT solve true network exactly-once delivery to Meta —
-- no client-supplied idempotency key on Meta's own send endpoint was found
-- to exist during the preceding audit (see that report's own sources).
-- What this table DOES guarantee: an ambiguous outcome is recorded as
-- `unknown` and NEVER silently retried, NEVER presented as sent_to_partner,
-- and NEVER presented as a certain failure either — see the new
-- partner_delivery_ambiguous command below.
--
-- Idempotent: every DDL statement is safe to re-run (IF NOT EXISTS
-- throughout). Does not modify any column/policy/grant from 0001_init.sql
-- through 0022_partner_transactional_consent.sql. The ONE exception, by
-- necessity, is `apply_partner_request_command()` itself and
-- `partner_request_events.event_type`'s own CHECK constraint: both are
-- extended here via `create or replace function` / drop+recreate of the
-- (unnamed-at-creation, Postgres-auto-named) check constraint — the
-- HISTORICAL FILE 0020_partner_requests.sql is never edited; this is the
-- standard, safe way to add one new closed-vocabulary value to an existing
-- function/constraint from a later migration.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

-- =========================================================================
-- A. partner_request_deliveries — one row per WhatsApp transmission
-- ATTEMPT. `purpose` is a CLOSED vocabulary distinguishing WHY this
-- particular attempt exists: `initial_request` (the first time this
-- request is sent to the partner, right after guest_confirm) vs
-- `alternative_acceptance` (retransmitting the guest's acceptance of a
-- partner-proposed alternative — see 0020's own comment on
-- guest_accept_alternative: it never moves status directly to
-- sent_to_partner, a NEW delivery attempt must do that). A single
-- partner_request can legitimately have MULTIPLE delivery rows over its
-- lifetime (one per purpose, and a `failed` attempt never blocks a later
-- explicit retry of the SAME purpose) — this table was designed against
-- that from the start, see the partial unique index below.
-- =========================================================================

create table if not exists public.partner_request_deliveries (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  partner_request_id uuid not null,

  provider text not null,
  purpose text not null
    check (purpose in ('initial_request', 'alternative_acceptance')),

  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed', 'unknown')),

  -- Meta's own message id (the "wamid..."), recorded ONLY on a CONFIRMED
  -- success (see complete_partner_request_delivery() below) — never
  -- invented, never derived from any internal id.
  provider_message_id text,

  -- SHA-256 hashes only — the raw opaque tokens themselves NEVER reach
  -- this table (see lib/notifications/whatsapp/replyToken.ts). Written
  -- atomically at the queued -> sending transition, BEFORE the network
  -- call to Meta is ever made (start_partner_request_delivery() below).
  accept_reply_token_hash text,
  reject_reply_token_hash text,
  propose_alternative_token_hash text,

  -- Closed/sanitized codes only (e.g. "provider_error", "provider_unknown",
  -- or a bare Meta numeric error code) — NEVER a phone number, a raw
  -- token, a secret, a full Meta response body, or free text that could
  -- carry PII. Enforced by application-code discipline, same as
  -- partner_request_events.message's own documented rule (0020's column
  -- comment) — not mechanically enforceable by a CHECK on free text.
  last_error_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint partner_request_deliveries_id_hotel_id_key unique (id, hotel_id),
  -- Tenant-safety at the schema level: a delivery can never reference a
  -- partner_request belonging to a different hotel_id — same composite-FK
  -- discipline as 0020's own partner_requests_partner_fk/
  -- partner_requests_conversation_fk.
  constraint partner_request_deliveries_request_fk
    foreign key (partner_request_id, hotel_id) references public.partner_requests (id, hotel_id)
);

comment on table public.partner_request_deliveries is
  'One row per WhatsApp transmission ATTEMPT for a partner_request (task: "0023 partner_request_deliveries"). Never the source of truth for the business status (partner_requests.status is) — this table exists to (1) make an ambiguous network outcome durable and never silently retried, and (2) correlate an inbound WhatsApp button tap back to the exact partner_request/command via an opaque, hashed reply token, never a decodable one. purpose distinguishes WHY this attempt exists (initial_request vs alternative_acceptance) since a single partner_request can legitimately be sent more than once over its lifetime.';

comment on column public.partner_request_deliveries.status is
  'queued (row reserved, network call not yet attempted) -> sending (about to call / calling the provider — the ONLY state a crash/timeout can leave ambiguous) -> sent (provider CONFIRMED success, provider_message_id set) | failed (provider CONFIRMED rejection before any doubt about delivery) | unknown (network exception/timeout AFTER the request left this server — Meta''s acceptance cannot be excluded). From unknown: NO automatic retry, by design (see application code) and by schema (unknown blocks a new attempt of the SAME purpose via the partial unique index below, same as sending/sent/queued) — a human must resolve it (e.g. move it to failed after confirming with the partner) before a new attempt of that purpose becomes possible.';

comment on column public.partner_request_deliveries.provider_message_id is
  'Meta''s own message id ("wamid..."), recorded ONLY when the provider''s response confirms success (never invented, never derived from partner_request_id).';

comment on column public.partner_request_deliveries.accept_reply_token_hash is
  'SHA-256 of the opaque, cryptographically random "Accepter" button reply token (lib/notifications/whatsapp/replyToken.ts) — the raw token is NEVER stored, logged, or derivable from this hash. Carries zero decodable information: unlike the earlier HMAC-signed design, Meta and the partner''s own device never see anything but a meaningless random string.';
comment on column public.partner_request_deliveries.reject_reply_token_hash is
  'Same discipline as accept_reply_token_hash, for the "Refuser" button.';
comment on column public.partner_request_deliveries.propose_alternative_token_hash is
  'Same discipline as accept_reply_token_hash, for the "Proposer une alternative" button.';

create index if not exists partner_request_deliveries_hotel_id_idx on public.partner_request_deliveries (hotel_id);
create index if not exists partner_request_deliveries_partner_request_id_idx on public.partner_request_deliveries (partner_request_id);

create trigger set_updated_at before update on public.partner_request_deliveries
  for each row execute function public.set_updated_at();

-- =========================================================================
-- B. Uniqueness constraints.
-- =========================================================================

-- Meta's own message id, when known, is never shared between two delivery
-- rows — lets a future status-webhook handler resolve "which delivery does
-- this wamid belong to" unambiguously (see task section 16: this migration
-- only PREPARES that lookup path, it does not build a status-webhook
-- handler in this pass).
create unique index if not exists partner_request_deliveries_provider_message_id_key
  on public.partner_request_deliveries (provider, provider_message_id)
  where provider_message_id is not null;

-- Each reply token hash is unique across the ENTIRE table, not just within
-- one delivery — a hash collision across two different deliveries would
-- let one delivery's token resolve to a foreign delivery's correlation
-- data, which must be structurally impossible.
create unique index if not exists partner_request_deliveries_accept_token_hash_key
  on public.partner_request_deliveries (accept_reply_token_hash)
  where accept_reply_token_hash is not null;
create unique index if not exists partner_request_deliveries_reject_token_hash_key
  on public.partner_request_deliveries (reject_reply_token_hash)
  where reject_reply_token_hash is not null;
create unique index if not exists partner_request_deliveries_alternative_token_hash_key
  on public.partner_request_deliveries (propose_alternative_token_hash)
  where propose_alternative_token_hash is not null;

-- THE concurrency guard (task section 12): at most ONE delivery per
-- (hotel_id, partner_request_id, purpose) may be in an ACTIVE state at a
-- time — queued/sending/sent/unknown. Two concurrent calls attempting to
-- create a delivery for the SAME request+purpose race on this index: the
-- loser's INSERT fails with 23505 (see
-- create_partner_request_delivery() below and deliveryService.ts's own
-- handling of that error) — no in-memory mutex anywhere.
--
-- `sent` is included deliberately: once a purpose has succeeded, that
-- exact purpose is done — a second `initial_request` (or a second
-- `alternative_acceptance` for the SAME acceptance) must never be created.
-- `unknown` is included deliberately too: this is what makes "no automatic
-- retry from unknown" a SCHEMA-level guarantee, not just an
-- application-code promise — a human must first resolve the ambiguous row
-- (e.g. move it to `failed`) before a new attempt of the SAME purpose can
-- even be inserted.
-- `failed` is deliberately EXCLUDED: a certain failure never blocks a new,
-- explicitly-authorized attempt of the same purpose.
-- `purpose` is part of the key: an `initial_request` sitting at `sent`
-- never blocks a LATER, independent `alternative_acceptance` delivery for
-- the same partner_request.
create unique index if not exists partner_request_deliveries_active_purpose_key
  on public.partner_request_deliveries (hotel_id, partner_request_id, purpose)
  where status in ('queued', 'sending', 'sent', 'unknown');

comment on index public.partner_request_deliveries_active_purpose_key is
  'At most one ACTIVE (queued/sending/sent/unknown) delivery per (hotel_id, partner_request_id, purpose). A concurrent second attempt for the same request+purpose fails with 23505 — deliveryService.ts::deliverPartnerRequest treats that as "another attempt is already in flight" and never calls the provider. failed is excluded on purpose: a certain failure never blocks a new, explicitly-authorized attempt of the same purpose. purpose is part of the key: initial_request and alternative_acceptance are fully independent and never block each other.';

alter table public.partner_request_deliveries enable row level security;

-- No policy for `authenticated`/`anon` at all: nothing in this codebase
-- reads this table from a session-bound client yet (no back-office/client-
-- portal screen consumes it in this pass) — least privilege. A future
-- screen that genuinely needs to display delivery status should add its
-- own narrow, tenant-scoped SELECT policy AND an explicit column list that
-- excludes every *_reply_token_hash column — never select("*") against
-- this table, same discipline as consent_token_hash
-- (0017_hotel_partner_consent.sql) and every other hash-only column in
-- this schema.
grant select on public.partner_request_deliveries to service_role;
revoke insert, update, delete on public.partner_request_deliveries from service_role;
revoke all on public.partner_request_deliveries from anon;

-- =========================================================================
-- C. create_partner_request_delivery — the ONLY way a
-- partner_request_deliveries row is ever created (status = 'queued').
-- SECURITY DEFINER, same caller-authorization rule as
-- create_partner_request()/apply_partner_request_command()
-- (0020_partner_requests.sql) — see that migration's own comment on the
-- auth.jwt() vs deprecated auth.role() reasoning.
-- =========================================================================

create or replace function public.create_partner_request_delivery(
  p_hotel_id uuid,
  p_partner_request_id uuid,
  p_provider text,
  p_purpose text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_ok boolean;
  v_new_id uuid;
begin
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.partner_requests where id = p_partner_request_id and hotel_id = p_hotel_id
  ) into v_request_ok;
  if not v_request_ok then
    raise exception 'partner_request not found for this hotel' using errcode = 'P0002';
  end if;

  -- p_purpose/p_provider format is additionally enforced by the table's
  -- own CHECK constraints — a malformed value fails this INSERT outright.
  -- A concurrent active delivery for the same (hotel_id, partner_request_id,
  -- purpose) fails this INSERT with 23505 — see
  -- partner_request_deliveries_active_purpose_key's own comment; the
  -- caller (deliveryService.ts) is expected to catch that specific
  -- SQLSTATE and treat it as "another attempt already in flight", never as
  -- a generic error.
  insert into public.partner_request_deliveries (hotel_id, partner_request_id, provider, purpose, status)
  values (p_hotel_id, p_partner_request_id, p_provider, p_purpose, 'queued')
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke execute on function public.create_partner_request_delivery(uuid, uuid, text, text) from public;
revoke execute on function public.create_partner_request_delivery(uuid, uuid, text, text) from anon;
grant execute on function public.create_partner_request_delivery(uuid, uuid, text, text) to authenticated, service_role;

-- =========================================================================
-- D. start_partner_request_delivery — the ONLY way a delivery moves from
-- 'queued' to 'sending', and the ONLY way the three reply-token hashes are
-- ever written. Called AFTER create_partner_request_delivery() succeeds
-- and BEFORE the network call to Meta is made (task section 11, step B/C)
-- — so even a crash immediately after this call leaves a durable 'sending'
-- row behind, never silently lost.
-- =========================================================================

create or replace function public.start_partner_request_delivery(
  p_delivery_id uuid,
  p_hotel_id uuid,
  p_accept_token_hash text,
  p_reject_token_hash text,
  p_propose_alternative_token_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select status into v_status
  from public.partner_request_deliveries
  where id = p_delivery_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'partner_request_delivery not found for this hotel' using errcode = 'P0002';
  end if;
  if v_status <> 'queued' then
    raise exception 'delivery not in queued status (found %)', v_status using errcode = 'P0001';
  end if;

  update public.partner_request_deliveries
  set status = 'sending',
      accept_reply_token_hash = p_accept_token_hash,
      reject_reply_token_hash = p_reject_token_hash,
      propose_alternative_token_hash = p_propose_alternative_token_hash
  where id = p_delivery_id;
end;
$$;

revoke execute on function public.start_partner_request_delivery(uuid, uuid, text, text, text) from public;
revoke execute on function public.start_partner_request_delivery(uuid, uuid, text, text, text) from anon;
grant execute on function public.start_partner_request_delivery(uuid, uuid, text, text, text) to authenticated, service_role;

-- =========================================================================
-- E. complete_partner_request_delivery — the ONLY way a delivery leaves
-- 'sending'. p_outcome is a closed vocabulary ('sent' | 'failed' |
-- 'unknown'), never a caller-chosen free string, and this function alone
-- decides which columns change — same "closed command, not a caller-chosen
-- status" discipline as apply_partner_request_command() itself.
-- provider_message_id is only ever written when p_outcome = 'sent' AND a
-- non-null value is supplied — never invented (task section 14).
-- =========================================================================

create or replace function public.complete_partner_request_delivery(
  p_delivery_id uuid,
  p_hotel_id uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_last_error_code text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if p_outcome not in ('sent', 'failed', 'unknown') then
    raise exception 'unknown outcome: %', p_outcome using errcode = 'P0001';
  end if;
  if p_outcome = 'sent' and p_provider_message_id is null then
    raise exception 'provider_message_id is required when outcome is sent' using errcode = 'P0001';
  end if;

  select status into v_status
  from public.partner_request_deliveries
  where id = p_delivery_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'partner_request_delivery not found for this hotel' using errcode = 'P0002';
  end if;
  if v_status <> 'sending' then
    raise exception 'delivery not in sending status (found %)', v_status using errcode = 'P0001';
  end if;

  update public.partner_request_deliveries
  set status = p_outcome,
      provider_message_id = case when p_outcome = 'sent' then p_provider_message_id else provider_message_id end,
      last_error_code = case when p_outcome in ('failed', 'unknown') then p_last_error_code else last_error_code end
  where id = p_delivery_id;
end;
$$;

revoke execute on function public.complete_partner_request_delivery(uuid, uuid, text, text, text) from public;
revoke execute on function public.complete_partner_request_delivery(uuid, uuid, text, text, text) from anon;
grant execute on function public.complete_partner_request_delivery(uuid, uuid, text, text, text) to authenticated, service_role;

-- =========================================================================
-- F. New event/command: partner_delivery_ambiguous — audits "a provider
-- call was made but its outcome could not be determined" WITHOUT ever
-- changing partner_requests.status (task section 10). Extends
-- partner_request_events.event_type's CHECK constraint (drop + recreate
-- the same, Postgres-auto-named constraint 0020 created implicitly) and
-- apply_partner_request_command() itself (create or replace, reproducing
-- 0020's body verbatim plus this one new branch) — 0020_partner_requests.sql
-- ITSELF is never edited; this is the standard, safe way to extend a
-- closed vocabulary from a later migration.
-- =========================================================================

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'partner_request_events_event_type_check'
      and conrelid = 'public.partner_request_events'::regclass
  ) then
    alter table public.partner_request_events drop constraint partner_request_events_event_type_check;
  end if;
end
$$;

alter table public.partner_request_events
  add constraint partner_request_events_event_type_check
  check (event_type in (
    'request_created',
    'guest_confirmation_requested',
    'guest_confirmed',
    'sent_to_partner',
    'partner_delivery_failed',
    'partner_delivery_ambiguous',
    'partner_accepted',
    'partner_rejected',
    'partner_alternative_proposed',
    'guest_accepted_alternative',
    'guest_rejected_alternative',
    'guest_notification_sent',
    'guest_notification_failed',
    'cancelled'
  ));

create or replace function public.apply_partner_request_command(
  p_partner_request_id uuid,
  p_hotel_id uuid,
  p_command text,
  p_message text default null,
  p_metadata jsonb default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_new_status text;
  v_event_type text;
  v_actor_type text;
begin
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select status into v_status
  from public.partner_requests
  where id = p_partner_request_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'partner_request not found for this hotel' using errcode = 'P0002';
  end if;

  v_new_status := v_status;

  case p_command
    when 'request_guest_confirmation' then
      if v_status <> 'draft' then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'guest_confirmation_requested';
      v_actor_type := 'system';
      v_new_status := 'pending_confirmation';

    when 'guest_confirm' then
      if v_status <> 'pending_confirmation' then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'guest_confirmed';
      v_actor_type := 'guest';

    when 'partner_delivery_succeeded' then
      if v_status not in ('pending_confirmation', 'alternative_proposed') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'sent_to_partner';
      v_actor_type := 'system';
      v_new_status := 'sent_to_partner';

    when 'partner_delivery_failed' then
      if v_status not in ('pending_confirmation', 'alternative_proposed') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'partner_delivery_failed';
      v_actor_type := 'system';

    when 'partner_delivery_ambiguous' then
      -- Same allowed source statuses as partner_delivery_succeeded/failed
      -- above: this represents a transmission ATTEMPT whose outcome could
      -- not be determined, from exactly the same states a real attempt is
      -- allowed to be made. status is deliberately left UNCHANGED — never
      -- sent_to_partner (no confirmed success), never treated as a certain
      -- failure either (a certain failure is what partner_delivery_failed
      -- is for). Falls through to the generic "v_new_status = v_status ->
      -- no UPDATE at all" branch below, exactly like partner_delivery_failed
      -- and guest_confirm/guest_accept_alternative already do.
      if v_status not in ('pending_confirmation', 'alternative_proposed') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'partner_delivery_ambiguous';
      v_actor_type := 'system';

    when 'partner_accept' then
      if v_status <> 'sent_to_partner' then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'partner_accepted';
      v_actor_type := 'partner';
      v_new_status := 'accepted';

    when 'partner_reject' then
      if v_status <> 'sent_to_partner' then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'partner_rejected';
      v_actor_type := 'partner';
      v_new_status := 'rejected';

    when 'partner_propose_alternative' then
      if v_status <> 'sent_to_partner' then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'partner_alternative_proposed';
      v_actor_type := 'partner';
      v_new_status := 'alternative_proposed';

    when 'guest_accept_alternative' then
      if v_status <> 'alternative_proposed' then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'guest_accepted_alternative';
      v_actor_type := 'guest';

    when 'guest_reject_alternative' then
      if v_status <> 'alternative_proposed' then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'guest_rejected_alternative';
      v_actor_type := 'guest';
      v_new_status := 'cancelled';

    when 'guest_notification_succeeded' then
      if v_status not in ('pending_confirmation', 'sent_to_partner', 'alternative_proposed', 'accepted', 'rejected', 'cancelled') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'guest_notification_sent';
      v_actor_type := 'system';

    when 'guest_notification_failed' then
      if v_status not in ('pending_confirmation', 'sent_to_partner', 'alternative_proposed', 'accepted', 'rejected', 'cancelled') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'guest_notification_failed';
      v_actor_type := 'system';

    when 'cancel_by_guest' then
      if v_status not in ('pending_confirmation', 'sent_to_partner', 'alternative_proposed') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'cancelled';
      v_actor_type := 'guest';
      v_new_status := 'cancelled';

    when 'cancel_by_hotel' then
      if v_status not in ('pending_confirmation', 'sent_to_partner', 'alternative_proposed') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'cancelled';
      v_actor_type := 'hotel';
      v_new_status := 'cancelled';

    when 'cancel_by_system' then
      if v_status not in ('pending_confirmation', 'sent_to_partner', 'alternative_proposed') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'cancelled';
      v_actor_type := 'system';
      v_new_status := 'cancelled';

    else
      raise exception 'unknown command: %', p_command using errcode = 'P0001';
  end case;

  if p_command = 'guest_notification_succeeded' then
    update public.partner_requests
    set guest_notification_status = 'sent', guest_notified_at = now()
    where id = p_partner_request_id;
  elsif p_command = 'guest_notification_failed' then
    update public.partner_requests
    set guest_notification_status = 'failed'
    where id = p_partner_request_id;
  elsif p_command in ('partner_accept', 'partner_reject', 'partner_propose_alternative') then
    update public.partner_requests
    set status = v_new_status, partner_response = p_message, responded_at = now()
    where id = p_partner_request_id;
  elsif v_new_status <> v_status then
    update public.partner_requests
    set status = v_new_status
    where id = p_partner_request_id;
  end if;

  insert into public.partner_request_events (hotel_id, partner_request_id, event_type, actor_type, message, metadata)
  values (p_hotel_id, p_partner_request_id, v_event_type, v_actor_type, p_message, p_metadata);
end;
$$;

revoke execute on function public.apply_partner_request_command(uuid, uuid, text, text, jsonb) from public;
revoke execute on function public.apply_partner_request_command(uuid, uuid, text, text, jsonb) from anon;
grant execute on function public.apply_partner_request_command(uuid, uuid, text, text, jsonb) to authenticated, service_role;
