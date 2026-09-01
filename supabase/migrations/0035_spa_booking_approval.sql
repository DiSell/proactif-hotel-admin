-- =========================================================================
-- Proactif System — spa_booking_approval: optional per-hotel manual
-- validation step for spa bookings, notified to the HOTEL (not the guest)
-- via WhatsApp — mirrors the already-built and proven partner_requests
-- WhatsApp notification mechanism (0023_partner_request_deliveries.sql)
-- almost exactly, minus the "purpose" dimension (spa approval only ever
-- has one kind of send) and with 2 reply buttons (Confirmer/Refuser)
-- instead of partner_requests' 3.
--
-- Uses the SAME shared, system-wide WhatsApp Business Account already used
-- for partner notifications (WHATSAPP_META_* env vars) — deliberately NOT
-- each hotel's own connected number (hotel_whatsapp_connections), which
-- this session's own audit confirmed is not wired to any send/receive path
-- today. A hotel admin's WhatsApp number for THIS feature is a new,
-- separate field (whatsapp_admin_phone_e164 below), unrelated to that
-- per-hotel connection.
--
-- Does NOT touch 0032/0033/0034 directly — extends 0034's table/functions
-- via ALTER/CREATE OR REPLACE only, same discipline 0023 already used to
-- extend 0020 without editing it.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- Also depends on a NEW Meta-approved message template
-- (WHATSAPP_SPA_BOOKING_APPROVAL_TEMPLATE) that only the establishment can
-- obtain via Meta Business Manager — no code change can accomplish that
-- external step.
-- =========================================================================

-- =========================================================================
-- A. hotel_spa_settings — approval mode + the WhatsApp number that receives
-- approval requests in manual mode. Deliberately scoped to this table (not
-- chatbot_settings) — no second consumer of a "WhatsApp admin number"
-- exists yet; generalize only once one does.
-- =========================================================================

alter table public.hotel_spa_settings
  add column approval_mode text not null default 'auto'
    check (approval_mode in ('auto', 'manual')),
  add column whatsapp_admin_phone_e164 text,
  add constraint hotel_spa_settings_whatsapp_admin_phone_e164_format
    check (whatsapp_admin_phone_e164 is null or whatsapp_admin_phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

comment on column public.hotel_spa_settings.approval_mode is
  '"auto": a booking is confirmed immediately on creation (original behavior). "manual": a booking is created as pending_approval and the hotel is notified via WhatsApp (whatsapp_admin_phone_e164) with Confirmer/Refuser buttons — the guest is told their request awaits validation, never that it is confirmed.';

-- =========================================================================
-- B. spa_bookings — extend the closed status vocabulary with
-- pending_approval, and add responded_at (mirrors partner_requests'
-- own responded_at). The inline CHECK from 0034 was never given an explicit
-- name, so Postgres auto-named it "spa_bookings_status_check" — dropped and
-- recreated here, exactly the pattern 0023 already used to extend 0020's
-- own event_type CHECK without editing that migration.
-- =========================================================================

alter table public.spa_bookings drop constraint spa_bookings_status_check;
alter table public.spa_bookings add constraint spa_bookings_status_check
  check (status in ('pending_approval', 'confirmed', 'cancelled'));
alter table public.spa_bookings alter column status set default 'pending_approval';

alter table public.spa_bookings add column responded_at timestamptz;

comment on column public.spa_bookings.status is
  'pending_approval: awaiting the hotel''s manual decision (approval_mode = ''manual'' only) — already occupies its slot''s capacity, exactly like confirmed, so a second concurrent booking cannot overbook while a decision is pending. confirmed: either auto-confirmed on creation (approval_mode = ''auto''), or approved from pending_approval. cancelled: guest/hotel/system cancellation, OR a rejected pending_approval request (rejecting IS cancelling — no separate status).';

-- create_spa_booking()'s own DEFAULT is not what sets the actual status
-- (see the function body below, which always sets it explicitly) — the
-- column default above only protects a hypothetical direct insert, which
-- is otherwise impossible (see the revoked grants in 0034).

-- =========================================================================
-- C. spa_booking_deliveries — one row per WhatsApp transmission ATTEMPT of
-- an approval request to the hotel. Mirrors partner_request_deliveries
-- (0023_partner_request_deliveries.sql) structurally, with NO `purpose`
-- column — spa approval only ever has one kind of send, unlike
-- partner_requests' initial_request/alternative_acceptance split.
-- =========================================================================

-- Composite-FK prerequisite: 0034 never added this unique constraint (spa
-- bookings had no reason to need one before this migration) — added here,
-- guarded so this migration stays safe to re-run.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'spa_bookings_id_hotel_id_key'
      and conrelid = 'public.spa_bookings'::regclass
  ) then
    alter table public.spa_bookings
      add constraint spa_bookings_id_hotel_id_key unique (id, hotel_id);
  end if;
end
$$;

create table public.spa_booking_deliveries (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  booking_id uuid not null,

  provider text not null,

  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed', 'unknown')),

  provider_message_id text,

  -- SHA-256 hashes only — same discipline as
  -- partner_request_deliveries.accept_reply_token_hash: the raw opaque
  -- token never reaches this table.
  accept_reply_token_hash text,
  reject_reply_token_hash text,

  last_error_code text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint spa_booking_deliveries_id_hotel_id_key unique (id, hotel_id),
  constraint spa_booking_deliveries_booking_fk
    foreign key (booking_id, hotel_id) references public.spa_bookings (id, hotel_id)
);

comment on table public.spa_booking_deliveries is
  'One row per WhatsApp transmission ATTEMPT of a spa-booking approval request to the hotel (task: "validation manuelle spa via WhatsApp"). Mirrors partner_request_deliveries (0023) minus the purpose dimension. Never the source of truth for spa_bookings.status.';

create index spa_booking_deliveries_hotel_id_idx on public.spa_booking_deliveries (hotel_id);
create index spa_booking_deliveries_booking_id_idx on public.spa_booking_deliveries (booking_id);

create unique index spa_booking_deliveries_provider_message_id_key
  on public.spa_booking_deliveries (provider, provider_message_id)
  where provider_message_id is not null;

create unique index spa_booking_deliveries_accept_token_hash_key
  on public.spa_booking_deliveries (accept_reply_token_hash)
  where accept_reply_token_hash is not null;
create unique index spa_booking_deliveries_reject_token_hash_key
  on public.spa_booking_deliveries (reject_reply_token_hash)
  where reject_reply_token_hash is not null;

-- At most one ACTIVE (queued/sending/sent/unknown) delivery per booking —
-- same concurrency guard as partner_request_deliveries_active_purpose_key,
-- minus the purpose dimension (there is only one purpose here).
create unique index spa_booking_deliveries_active_booking_key
  on public.spa_booking_deliveries (hotel_id, booking_id)
  where status in ('queued', 'sending', 'sent', 'unknown');

create trigger set_updated_at before update on public.spa_booking_deliveries
  for each row execute function public.set_updated_at();

alter table public.spa_booking_deliveries enable row level security;

-- No policy for authenticated/anon — same reasoning as
-- partner_request_deliveries: nothing reads this table from a session-bound
-- client, and it carries reply-token hashes that must never be selectable
-- outside the SECURITY DEFINER functions below.
grant select on public.spa_booking_deliveries to service_role;
revoke insert, update, delete on public.spa_booking_deliveries from service_role;
revoke all on public.spa_booking_deliveries from anon;

-- =========================================================================
-- D. create_spa_booking_delivery / start_spa_booking_delivery /
-- complete_spa_booking_delivery — mirror the three equivalent
-- partner_request_deliveries functions (0023) exactly, minus p_purpose.
-- =========================================================================

create or replace function public.create_spa_booking_delivery(
  p_hotel_id uuid,
  p_booking_id uuid,
  p_provider text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking_ok boolean;
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
    select 1 from public.spa_bookings where id = p_booking_id and hotel_id = p_hotel_id
  ) into v_booking_ok;
  if not v_booking_ok then
    raise exception 'spa_booking not found for this hotel' using errcode = 'P0002';
  end if;

  insert into public.spa_booking_deliveries (hotel_id, booking_id, provider, status)
  values (p_hotel_id, p_booking_id, p_provider, 'queued')
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke execute on function public.create_spa_booking_delivery(uuid, uuid, text) from public;
revoke execute on function public.create_spa_booking_delivery(uuid, uuid, text) from anon;
grant execute on function public.create_spa_booking_delivery(uuid, uuid, text) to authenticated, service_role;

create or replace function public.start_spa_booking_delivery(
  p_delivery_id uuid,
  p_hotel_id uuid,
  p_accept_token_hash text,
  p_reject_token_hash text
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
  from public.spa_booking_deliveries
  where id = p_delivery_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'spa_booking_delivery not found for this hotel' using errcode = 'P0002';
  end if;
  if v_status <> 'queued' then
    raise exception 'delivery not in queued status (found %)', v_status using errcode = 'P0001';
  end if;

  update public.spa_booking_deliveries
  set status = 'sending',
      accept_reply_token_hash = p_accept_token_hash,
      reject_reply_token_hash = p_reject_token_hash
  where id = p_delivery_id;
end;
$$;

revoke execute on function public.start_spa_booking_delivery(uuid, uuid, text, text) from public;
revoke execute on function public.start_spa_booking_delivery(uuid, uuid, text, text) from anon;
grant execute on function public.start_spa_booking_delivery(uuid, uuid, text, text) to authenticated, service_role;

create or replace function public.complete_spa_booking_delivery(
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
  from public.spa_booking_deliveries
  where id = p_delivery_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'spa_booking_delivery not found for this hotel' using errcode = 'P0002';
  end if;
  if v_status <> 'sending' then
    raise exception 'delivery not in sending status (found %)', v_status using errcode = 'P0001';
  end if;

  update public.spa_booking_deliveries
  set status = p_outcome,
      provider_message_id = case when p_outcome = 'sent' then p_provider_message_id else provider_message_id end,
      last_error_code = case when p_outcome in ('failed', 'unknown') then p_last_error_code else last_error_code end
  where id = p_delivery_id;
end;
$$;

revoke execute on function public.complete_spa_booking_delivery(uuid, uuid, text, text, text) from public;
revoke execute on function public.complete_spa_booking_delivery(uuid, uuid, text, text, text) from anon;
grant execute on function public.complete_spa_booking_delivery(uuid, uuid, text, text, text) to authenticated, service_role;

-- =========================================================================
-- E. create_spa_booking() — create or replace (0034 itself never edited).
-- Same body as 0034's version, with two changes: (1) initial status
-- depends on hotel_spa_settings.approval_mode, (2) the capacity aggregate
-- now counts pending_approval alongside confirmed — a request awaiting
-- the hotel's decision already occupies its slot.
-- =========================================================================

create or replace function public.create_spa_booking(
  p_hotel_id uuid,
  p_conversation_id uuid,
  p_guest_name text,
  p_guest_phone_e164 text,
  p_party_size integer,
  p_is_non_resident boolean,
  p_notes text,
  p_booking_date date,
  p_slot_start time
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings public.hotel_spa_settings%rowtype;
  v_slot_end time;
  v_offset_minutes integer;
  v_current_total integer;
  v_initial_status text;
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

  select * into v_settings from public.hotel_spa_settings where hotel_id = p_hotel_id;
  if v_settings is null or not v_settings.enabled then
    raise exception 'spa booking not enabled for this hotel' using errcode = 'P1001';
  end if;

  if p_booking_date < current_date or p_booking_date > current_date + v_settings.advance_booking_days then
    raise exception 'booking_date outside the allowed advance-booking window' using errcode = 'P1002';
  end if;

  v_slot_end := p_slot_start + (v_settings.slot_duration_minutes || ' minutes')::interval;
  v_offset_minutes := round(extract(epoch from (p_slot_start - v_settings.opens_at)) / 60);

  if p_slot_start < v_settings.opens_at
     or v_slot_end > v_settings.closes_at
     or v_offset_minutes % v_settings.slot_duration_minutes <> 0 then
    raise exception 'slot_start is not a valid slot boundary for this hotel''s opening hours' using errcode = 'P1003';
  end if;

  if p_booking_date = current_date and (p_booking_date + p_slot_start)::timestamptz < now() + (v_settings.min_notice_hours || ' hours')::interval then
    raise exception 'slot_start does not respect the minimum notice period' using errcode = 'P1004';
  end if;

  if p_is_non_resident and not v_settings.allow_non_residents then
    raise exception 'non-resident bookings are not allowed for this hotel' using errcode = 'P1005';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('spa_booking:' || p_hotel_id::text || ':' || p_booking_date::text || ':' || p_slot_start::text, 0));

  -- pending_approval counts toward capacity too: a request awaiting the
  -- hotel's decision has already claimed its place in the slot.
  select coalesce(sum(party_size), 0) into v_current_total
  from public.spa_bookings
  where hotel_id = p_hotel_id and booking_date = p_booking_date and slot_start = p_slot_start
    and status in ('confirmed', 'pending_approval');

  if v_current_total + p_party_size > v_settings.capacity_per_slot then
    raise exception 'this slot is fully booked' using errcode = 'P1006';
  end if;

  v_initial_status := case when v_settings.approval_mode = 'manual' then 'pending_approval' else 'confirmed' end;

  insert into public.spa_bookings (
    hotel_id, conversation_id, guest_name, guest_phone_e164, party_size, is_non_resident, notes,
    booking_date, slot_start, slot_end, price_per_person_snapshot, status
  ) values (
    p_hotel_id, p_conversation_id, p_guest_name, p_guest_phone_e164, p_party_size, p_is_non_resident, p_notes,
    p_booking_date, p_slot_start, v_slot_end, v_settings.price_per_person, v_initial_status
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke execute on function public.create_spa_booking(uuid, uuid, text, text, integer, boolean, text, date, time) from public;
revoke execute on function public.create_spa_booking(uuid, uuid, text, text, integer, boolean, text, date, time) from anon;
grant execute on function public.create_spa_booking(uuid, uuid, text, text, integer, boolean, text, date, time) to authenticated, service_role;

-- =========================================================================
-- F. approve_spa_booking — the ONLY way a pending_approval booking becomes
-- confirmed via the hotel's decision. Same caller-authorization rule as
-- every other spa function.
-- =========================================================================

create or replace function public.approve_spa_booking(
  p_hotel_id uuid,
  p_booking_id uuid
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
  from public.spa_bookings
  where id = p_booking_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'spa_booking not found for this hotel' using errcode = 'P1007';
  end if;
  if v_status <> 'pending_approval' then
    raise exception 'spa_booking is not pending approval (found %)', v_status using errcode = 'P1008';
  end if;

  update public.spa_bookings
  set status = 'confirmed', responded_at = now()
  where id = p_booking_id;
end;
$$;

revoke execute on function public.approve_spa_booking(uuid, uuid) from public;
revoke execute on function public.approve_spa_booking(uuid, uuid) from anon;
grant execute on function public.approve_spa_booking(uuid, uuid) to authenticated, service_role;

-- =========================================================================
-- G. cancel_spa_booking — create or replace: now also accepts
-- pending_approval as a valid source status (rejecting a pending request IS
-- cancelling it — same terminal outcome, no separate "reject" status), and
-- records responded_at alongside cancelled_by/cancelled_at.
-- =========================================================================

create or replace function public.cancel_spa_booking(
  p_hotel_id uuid,
  p_booking_id uuid,
  p_cancelled_by text
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

  if p_cancelled_by not in ('guest', 'hotel', 'system') then
    raise exception 'invalid cancelled_by value: %', p_cancelled_by using errcode = 'P0001';
  end if;

  select status into v_status
  from public.spa_bookings
  where id = p_booking_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'spa_booking not found for this hotel' using errcode = 'P1007';
  end if;
  if v_status not in ('confirmed', 'pending_approval') then
    raise exception 'spa_booking is not in a cancellable status (found %)', v_status using errcode = 'P1008';
  end if;

  update public.spa_bookings
  set status = 'cancelled', cancelled_by = p_cancelled_by, cancelled_at = now(), responded_at = now()
  where id = p_booking_id;
end;
$$;

revoke execute on function public.cancel_spa_booking(uuid, uuid, text) from public;
revoke execute on function public.cancel_spa_booking(uuid, uuid, text) from anon;
grant execute on function public.cancel_spa_booking(uuid, uuid, text) to authenticated, service_role;
