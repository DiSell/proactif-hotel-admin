-- =========================================================================
-- Proactif System — partner_requests: the guest -> partner -> guest
-- reservation-request workflow (a NEW, distinct action from simply being
-- recommended by the chatbot — see hotel_partners.consent_status,
-- 0017_hotel_partner_consent.sql). Additive only.
--
-- Deliberately provider-agnostic: nothing in this migration or in the two
-- RPC functions below knows anything about WhatsApp/Twilio/Meta payload
-- shapes. A future notification layer (src/lib/notifications/whatsapp/...,
-- not built yet) calls apply_partner_request_command() with a plain
-- business command; it never reaches into this schema directly.
--
-- State machine, command vocabulary, and the "current-state projection vs
-- append-only event log" split below are the exact result of the
-- multi-round design review already conducted (partner_requests /
-- partner_request_events / 14 commands / 13 event types) — nothing here is
-- improvised at migration time.
-- =========================================================================

-- =========================================================================
-- A. Composite unique constraints — required so partner_requests can carry
-- tenant-safe composite foreign keys (below) instead of relying solely on
-- application-level `.eq("hotel_id", ...)` checks. Trivially satisfiable:
-- `id` is already each table's primary key (hence already unique alone),
-- so `(id, hotel_id)` is guaranteed unique with no data migration risk.
--
-- Guarded with an explicit pg_constraint existence check rather than a
-- bare `ADD CONSTRAINT` — PostgreSQL has no reliable
-- `ADD CONSTRAINT IF NOT EXISTS` across all constraint types, and this
-- migration must stay safe to re-run against a database where either
-- constraint (or both) may already exist from an earlier partial attempt,
-- without ever dropping or altering a pre-existing, already-correct one.
-- =========================================================================

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hotel_partners_id_hotel_id_key'
      and conrelid = 'public.hotel_partners'::regclass
  ) then
    alter table public.hotel_partners
      add constraint hotel_partners_id_hotel_id_key unique (id, hotel_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'conversations_id_hotel_id_key'
      and conrelid = 'public.conversations'::regclass
  ) then
    alter table public.conversations
      add constraint conversations_id_hotel_id_key unique (id, hotel_id);
  end if;
end
$$;

-- =========================================================================
-- B. hotel_partners — operational contact number for routing requests.
-- Deliberately a SEPARATE column from `phone` (already shown publicly to
-- guests, per features/rag/partners.ts's own phone-display feature) — a
-- partner's request-routing number can differ from the number they publish
-- to the public. Server-resolved only (future notification layer), never
-- derived from the model, never to be added to PARTNER_COLUMNS
-- (features/partners/queries.ts) — same "never exposed to the browser"
-- discipline already applied to consent_token_hash.
-- =========================================================================

alter table public.hotel_partners
  add column request_phone_e164 text;

alter table public.hotel_partners
  add constraint hotel_partners_request_phone_e164_format
    check (request_phone_e164 is null or request_phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

comment on column public.hotel_partners.request_phone_e164 is
  'Operational contact number used to route partner_requests to this partner (E.164). Deliberately separate from the public-facing "phone" column. Server-resolved only, never derived from the model, never exposed via PARTNER_COLUMNS (features/partners/queries.ts) — same discipline already applied to consent_token_hash.';

-- =========================================================================
-- C. partner_requests — current-state PROJECTION. Always the single source
-- of truth for "where does this request stand right now" — never computed
-- by replaying partner_request_events (see the table comment below on
-- that table's own, distinct role).
-- =========================================================================

create table public.partner_requests (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  partner_id uuid not null,
  conversation_id uuid not null,

  guest_name text,
  guest_phone_e164 text,

  request_category text not null,
  requested_date date,
  requested_time text,
  party_size integer,
  details text,

  status text not null default 'draft'
    check (status in ('draft', 'pending_confirmation', 'sent_to_partner', 'accepted', 'rejected', 'alternative_proposed', 'cancelled')),

  partner_response text,
  responded_at timestamptz,

  guest_notification_status text not null default 'pending'
    check (guest_notification_status in ('pending', 'sent', 'failed')),
  guest_notified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint partner_requests_guest_phone_e164_format
    check (guest_phone_e164 is null or guest_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint partner_requests_id_hotel_id_key unique (id, hotel_id),
  -- Tenant-safety at the schema level, not just in application code: a row
  -- can never reference a partner or a conversation belonging to a
  -- different hotel_id — Postgres itself rejects it, independent of any
  -- application bug or direct SQL misuse.
  constraint partner_requests_partner_fk foreign key (partner_id, hotel_id) references public.hotel_partners (id, hotel_id),
  constraint partner_requests_conversation_fk foreign key (conversation_id, hotel_id) references public.conversations (id, hotel_id)
);

comment on table public.partner_requests is
  'Current-state projection for the guest -> partner -> guest reservation-request workflow. status/partner_response/responded_at/guest_notification_status/guest_notified_at always hold the LAST useful value only — full history lives in partner_request_events. Written exclusively by create_partner_request()/apply_partner_request_command() (see grants below: no role holds direct INSERT/UPDATE/DELETE on this table).';

comment on column public.partner_requests.guest_phone_e164 is
  'PII. Never injected into any RAG prompt/instructions (features/rag/), never logged in plaintext, never exposed via any public/anon-reachable API. Collected via a dedicated structured widget step, or extracted+redacted from free text via features/partnerRequests/phoneRedaction.ts — the model itself is only ever told a boolean (guest_phone_collected), never the raw number.';

create index partner_requests_hotel_id_idx on public.partner_requests (hotel_id);
create index partner_requests_partner_id_idx on public.partner_requests (partner_id);
create index partner_requests_conversation_id_idx on public.partner_requests (conversation_id);
create index partner_requests_status_idx on public.partner_requests (status);

-- Reuses the existing shared trigger function from 0001_init.sql — same
-- pattern already used for hotels/chatbot_settings/widget_settings/
-- knowledge_sources/hotel_partners, no new mechanism introduced.
create trigger set_updated_at before update on public.partner_requests
  for each row execute function public.set_updated_at();

alter table public.partner_requests enable row level security;

create policy "superadmin can select partner_requests" on public.partner_requests
  for select using (public.is_superadmin());

create policy "hotel_admin can select own partner_requests" on public.partner_requests
  for select using (public.is_hotel_admin_for(hotel_id));

-- Deliberately NO insert/update/delete policy at all, for any role. The
-- only legitimate write path is the two SECURITY DEFINER functions below,
-- which enforce the state machine and tenant checks themselves — see the
-- explicit revokes further down, which make this a schema-level guarantee,
-- not just "no policy happens to allow it".

grant select on public.partner_requests to authenticated;
revoke insert, update, delete on public.partner_requests from authenticated;

grant select on public.partner_requests to service_role;
revoke insert, update, delete on public.partner_requests from service_role;

revoke all on public.partner_requests from anon;

-- =========================================================================
-- D. partner_request_events — append-only audit log. NEVER used to compute
-- current status (partner_requests above is the single source of truth
-- for that) — this table exists purely for audit/debugging/support. No
-- updated_at column, no update trigger: rows are never modified after
-- insert.
-- =========================================================================

create table public.partner_request_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  partner_request_id uuid not null,

  event_type text not null check (event_type in (
    'request_created',
    'guest_confirmation_requested',
    'guest_confirmed',
    'sent_to_partner',
    'partner_delivery_failed',
    'partner_accepted',
    'partner_rejected',
    'partner_alternative_proposed',
    'guest_accepted_alternative',
    'guest_rejected_alternative',
    'guest_notification_sent',
    'guest_notification_failed',
    'cancelled'
  )),
  actor_type text not null check (actor_type in ('guest', 'partner', 'hotel', 'system')),

  message text,
  metadata jsonb,

  created_at timestamptz not null default now(),

  constraint partner_request_events_request_fk foreign key (partner_request_id, hotel_id) references public.partner_requests (id, hotel_id)
);

comment on table public.partner_request_events is
  'Append-only audit log for partner_requests. Never updated or deleted by application code, and (see grants below) no role other than the two SECURITY DEFINER RPC functions can write to it at all — append-only is a property of the SCHEMA here, not just a TypeScript-level convention. partner_requests.status/... remain the single source of truth for current state; this table is never queried to compute it.';

comment on column public.partner_request_events.message is
  'Free text (e.g. a partner''s raw reply, or a sanitized delivery-failure reason). Callers MUST sanitize before passing this to apply_partner_request_command() — this column must never contain guest_phone_e164, hotel_partners.request_phone_e164, or any other raw PII. Not enforceable by a DB CHECK on free text; enforced by discipline in every caller.';

comment on column public.partner_request_events.metadata is
  'Structured extra data (e.g. a partner-proposed alternative date/time). Same rule as message: never a phone number or other PII — sanitized by the caller before this is ever written.';

create index partner_request_events_partner_request_id_idx on public.partner_request_events (partner_request_id);
create index partner_request_events_hotel_id_idx on public.partner_request_events (hotel_id);

alter table public.partner_request_events enable row level security;

create policy "superadmin can select partner_request_events" on public.partner_request_events
  for select using (public.is_superadmin());

create policy "hotel_admin can select own partner_request_events" on public.partner_request_events
  for select using (public.is_hotel_admin_for(hotel_id));

grant select on public.partner_request_events to authenticated;
revoke insert, update, delete on public.partner_request_events from authenticated;

grant select on public.partner_request_events to service_role;
revoke insert, update, delete on public.partner_request_events from service_role;

revoke all on public.partner_request_events from anon;

-- =========================================================================
-- E. is_superadmin()/is_hotel_admin_for() (0001_init.sql /
-- 0011_hotel_client_portal.sql) already grant EXECUTE to `authenticated`
-- only, never to `service_role`. Deliberately NOT granting `service_role`
-- EXECUTE on them here, per minimum-privilege: both are themselves
-- SECURITY DEFINER, so when create_partner_request()/
-- apply_partner_request_command() below call them, the EXECUTE privilege
-- check for that nested call is evaluated against the CALLING function's
-- OWNER (a SECURITY DEFINER function runs — including everything it calls
-- that isn't itself a role-switching SECURITY DEFINER with a different
-- owner — under its owner's identity, not the original invoker's), not
-- against `service_role`/`authenticated` directly. Since these functions
-- share the same owner as is_superadmin()/is_hotel_admin_for() (the role
-- that ran this migration), the nested call already succeeds without any
-- additional grant. Adding one anyway would be an unjustified privilege
-- widening this migration does not need.
-- =========================================================================

-- =========================================================================
-- F. create_partner_request — the ONLY way a partner_requests row (and its
-- matching request_created event) is ever created. SECURITY DEFINER: this
-- function's own writes succeed under its OWNER's privileges, independent
-- of the caller's own grants on partner_requests/partner_request_events
-- (which are revoked for everyone — see section C/D above). Authorization
-- is therefore checked EXPLICITLY inside the function body, never
-- delegated to RLS (a SECURITY DEFINER function bypasses RLS by
-- definition).
-- =========================================================================

create or replace function public.create_partner_request(
  p_hotel_id uuid,
  p_partner_id uuid,
  p_conversation_id uuid,
  p_guest_name text,
  p_guest_phone_e164 text,
  p_request_category text,
  p_requested_date date,
  p_requested_time text,
  p_party_size integer,
  p_details text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_partner_ok boolean;
  v_conversation_ok boolean;
  v_new_id uuid;
begin
  -- Caller authorization: service_role (the trusted server/widget engine —
  -- same trust boundary already used by features/rag/chatEndpoint.ts and
  -- the widget chat route) OR an authenticated superadmin OR the
  -- hotel_admin for THIS exact hotel_id. Nothing else is authorized.
  --
  -- auth.role() is deprecated by Supabase — reading the JWT's own "role"
  -- claim directly via auth.jwt() is the current recommended idiom.
  -- IMPORTANT: this is the first place in this codebase's migrations that
  -- needs to distinguish caller identity for a MULTI-ROLE entry point (every
  -- prior SECURITY DEFINER function here — is_superadmin(),
  -- is_hotel_admin_for() — only ever runs as `authenticated`) — verify
  -- auth.jwt() ->> 'role' behaves as expected against the actual deployed
  -- Supabase project before relying on this in production; it could not be
  -- exercised against a live database while writing this migration.
  --
  -- Being authenticated is NOT sufficient on its own — a plain
  -- `role = authenticated` JWT still falls through to the explicit
  -- is_superadmin()/is_hotel_admin_for() checks below.
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- The partner must belong to THIS hotel, be active, AND have accepted
  -- the (separate, earlier) consent-to-be-recommended flow — never assumed,
  -- always re-checked here regardless of what the caller believes to be true.
  select exists (
    select 1
    from public.hotel_partners
    where id = p_partner_id
      and hotel_id = p_hotel_id
      and is_active = true
      and consent_status = 'accepted'
  ) into v_partner_ok;
  if not v_partner_ok then
    raise exception 'partner not found, inactive, or consent not accepted for this hotel' using errcode = 'P0001';
  end if;

  select exists (
    select 1 from public.conversations where id = p_conversation_id and hotel_id = p_hotel_id
  ) into v_conversation_ok;
  if not v_conversation_ok then
    raise exception 'conversation not found for this hotel' using errcode = 'P0001';
  end if;

  -- guest_phone_e164 format is additionally enforced by the table's own
  -- CHECK constraint (partner_requests_guest_phone_e164_format) — a
  -- malformed value fails this INSERT outright, never silently stored.
  insert into public.partner_requests (
    hotel_id, partner_id, conversation_id, guest_name, guest_phone_e164,
    request_category, requested_date, requested_time, party_size, details, status
  ) values (
    p_hotel_id, p_partner_id, p_conversation_id, p_guest_name, p_guest_phone_e164,
    p_request_category, p_requested_date, p_requested_time, p_party_size, p_details, 'draft'
  )
  returning id into v_new_id;

  insert into public.partner_request_events (hotel_id, partner_request_id, event_type, actor_type)
  values (p_hotel_id, v_new_id, 'request_created', 'guest');

  return v_new_id;
end;
$$;

revoke execute on function public.create_partner_request(uuid, uuid, uuid, text, text, text, date, text, integer, text) from public;
revoke execute on function public.create_partner_request(uuid, uuid, uuid, text, text, text, date, text, integer, text) from anon;
grant execute on function public.create_partner_request(uuid, uuid, uuid, text, text, text, date, text, integer, text) to authenticated, service_role;

-- =========================================================================
-- G. apply_partner_request_command — the ONLY way a partner_requests row
-- ever changes after creation, and the ONLY way a partner_request_events
-- row is ever inserted after the initial request_created one. The caller
-- NEVER supplies event_type, actor_type, or a target status directly —
-- only a closed business command (p_command); this function alone derives
-- event_type/actor_type/the resulting status/which projection fields
-- change, exactly per the validated command table. This is what makes it
-- impossible for a caller to fabricate an inconsistent event (e.g. an
-- event_type of "partner_accepted" with actor_type "guest").
-- =========================================================================

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
  -- Same caller-authorization rule as create_partner_request() above —
  -- see that function's own comment for the auth.jwt() vs deprecated
  -- auth.role() reasoning, and the note that this could not be verified
  -- against a live Supabase project.
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  -- Row lock FIRST — two commands racing on the same partner_request are
  -- serialized here: the second waits for the first transaction to
  -- commit, then re-reads the (now-updated) status below before deciding
  -- whether ITS OWN command is still legal.
  select status into v_status
  from public.partner_requests
  where id = p_partner_request_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'partner_request not found for this hotel' using errcode = 'P0002';
  end if;

  v_new_status := v_status; -- default: unchanged unless a branch below overwrites it

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
      -- status unchanged: confirming does NOT mean transmitted yet.

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
      -- status unchanged: NEVER a path to sent_to_partner. Only
      -- partner_delivery_succeeded ever produces that status/event.

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
      -- status unchanged: the acceptance must still be retransmitted and
      -- confirmed via partner_delivery_succeeded before this ever becomes
      -- sent_to_partner. Never a direct path to accepted.

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
      -- status unchanged — notifying the guest is never a reservation
      -- transition, including after a terminal outcome.

    when 'guest_notification_failed' then
      if v_status not in ('pending_confirmation', 'sent_to_partner', 'alternative_proposed', 'accepted', 'rejected', 'cancelled') then
        raise exception 'command % not allowed from status %', p_command, v_status using errcode = 'P0001';
      end if;
      v_event_type := 'guest_notification_failed';
      v_actor_type := 'system';
      -- status unchanged.

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

  -- Projection write — only touches what this specific command actually
  -- changes. guest_confirm / guest_accept_alternative / partner_delivery_failed
  -- fall through to "no UPDATE at all": nothing on partner_requests changes
  -- for these three, only the event below is written.
  if p_command = 'guest_notification_succeeded' then
    update public.partner_requests
    set guest_notification_status = 'sent', guest_notified_at = now()
    where id = p_partner_request_id;
  elsif p_command = 'guest_notification_failed' then
    -- guest_notified_at deliberately left untouched on failure.
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
