-- =========================================================================
-- Proactif System — spa_bookings: guest spa reservations made entirely
-- inside the chatbot conversation. Additive only.
--
-- Deliberately SIMPLER than partner_requests (0020_partner_requests.sql):
-- there is no accept/reject negotiation state machine here — a booking is
-- auto-confirmed the moment it's created (the hotel doesn't approve it, it
-- is only NOTIFIED so staff can be present), so there is no
-- spa_booking_events audit-log table and no delivery-attempt-tracking table
-- either (email notification is fire-and-forget, unlike partner_requests'
-- WhatsApp reply-token correlation). status is only ever 'confirmed' or
-- 'cancelled'.
--
-- What IS genuinely harder than partner_requests: real capacity enforcement
-- under concurrency. partner_requests never validates its free-text
-- date/time against anything; a spa booking must never let two concurrent
-- confirmations overbook the same slot. See create_spa_booking() below for
-- the advisory-lock + exact-aggregate approach.
--
-- All writes go through the three SECURITY DEFINER functions below — same
-- discipline as partner_requests: no insert/update/delete policy exists for
-- any role, at the database level, on spa_bookings.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

-- =========================================================================
-- A. spa_bookings — one row per guest reservation.
-- =========================================================================

create table public.spa_bookings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  conversation_id uuid not null,

  guest_name text,
  guest_phone_e164 text,
  party_size integer not null,
  is_non_resident boolean not null default false,
  notes text,

  booking_date date not null,
  slot_start time not null,
  slot_end time not null,
  price_per_person_snapshot numeric(10, 2),

  status text not null default 'confirmed'
    check (status in ('confirmed', 'cancelled')),
  cancelled_by text check (cancelled_by is null or cancelled_by in ('guest', 'hotel', 'system')),
  cancelled_at timestamptz,

  owner_notification_status text not null default 'pending'
    check (owner_notification_status in ('pending', 'sent', 'failed')),
  owner_notified_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint spa_bookings_party_size_positive check (party_size > 0),
  constraint spa_bookings_guest_phone_e164_format check (guest_phone_e164 is null or guest_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  -- Tenant-safety at the schema level, same discipline as
  -- partner_requests_conversation_fk (0020_partner_requests.sql): a booking
  -- can never reference a conversation belonging to a different hotel_id —
  -- reuses the (id, hotel_id) unique constraint 0020 already added to
  -- conversations.
  constraint spa_bookings_conversation_fk foreign key (conversation_id, hotel_id) references public.conversations (id, hotel_id)
);

comment on table public.spa_bookings is
  'Guest spa reservations, created exclusively via create_spa_booking() (never a direct insert). Auto-confirmed on creation — no accept/reject step, unlike partner_requests. status/cancelled_by/cancelled_at/owner_notification_status/owner_notified_at are written exclusively by the three SECURITY DEFINER functions below (see grants: no role holds direct INSERT/UPDATE/DELETE on this table).';

comment on column public.spa_bookings.slot_end is
  'Snapshot of booking_date''s slot end, computed from hotel_spa_settings.slot_duration_minutes AT BOOKING TIME — never recomputed later, so a subsequent change to the hotel''s settings never retroactively alters an existing booking.';

comment on column public.spa_bookings.price_per_person_snapshot is
  'Snapshot of hotel_spa_settings.price_per_person AT BOOKING TIME — same reasoning as slot_end. Informational only in this phase (no payment collection).';

-- Idempotency guard: at most one ACTIVE (confirmed) booking per
-- (conversation, date, slot) — the spa equivalent of
-- 0021_partner_requests_active_idempotency.sql. Does NOT cap a guest to one
-- booking per conversation (a guest can legitimately book different
-- slots/days in the same conversation) — it only prevents a genuine network
-- retry of the same confirmation from creating two rows for the exact same
-- slot. See features/spa/booking.ts's own 23505 recovery.
create unique index spa_bookings_active_slot_per_conversation_idx
  on public.spa_bookings (conversation_id, booking_date, slot_start)
  where status = 'confirmed';

-- The capacity-aggregation query's own index (create_spa_booking below sums
-- party_size for one exact hotel_id/booking_date/slot_start).
create index spa_bookings_hotel_date_slot_idx on public.spa_bookings (hotel_id, booking_date, slot_start);
create index spa_bookings_hotel_id_idx on public.spa_bookings (hotel_id);
create index spa_bookings_conversation_id_idx on public.spa_bookings (conversation_id);

create trigger set_updated_at before update on public.spa_bookings
  for each row execute function public.set_updated_at();

alter table public.spa_bookings enable row level security;

create policy "superadmin can select spa_bookings" on public.spa_bookings
  for select using (public.is_superadmin());

create policy "hotel_admin can select own spa_bookings" on public.spa_bookings
  for select using (public.is_hotel_admin_for(hotel_id));

-- Deliberately NO insert/update/delete policy at all, for any role — same
-- reasoning as partner_requests (0020_partner_requests.sql section C): the
-- only legitimate write paths are the three SECURITY DEFINER functions
-- below, which enforce the real business rules (capacity, hours, advance
-- window, race-safety) themselves. Explicit revokes make this a
-- schema-level guarantee, not just "no policy happens to allow it".

grant select on public.spa_bookings to authenticated;
revoke insert, update, delete on public.spa_bookings from authenticated;

grant select on public.spa_bookings to service_role;
revoke insert, update, delete on public.spa_bookings from service_role;

revoke all on public.spa_bookings from anon;

-- =========================================================================
-- B. create_spa_booking — the ONLY way a spa_bookings row is ever created.
-- SECURITY DEFINER: succeeds under its OWNER's privileges independent of
-- the caller's own grants (revoked for everyone above) — authorization is
-- therefore checked EXPLICITLY inside the function body, never delegated to
-- RLS. Same caller-authorization rule as create_partner_request()
-- (0020_partner_requests.sql) — see that migration's own comment on the
-- auth.jwt() vs deprecated auth.role() reasoning, and its note that this
-- could not be exercised against a live Supabase project while writing the
-- migration.
--
-- Error codes (all in the plpgsql user-error convention, none colliding
-- with Postgres built-ins) — the TypeScript wrapper
-- (features/spa/booking.ts::createSpaBookingForChatbot) pattern-matches on
-- these to produce a specific, actionable guest-facing message instead of a
-- generic failure:
--   42501 — caller not authorized
--   P1001 — spa booking not enabled for this hotel
--   P1002 — booking_date outside [today, today + advance_booking_days]
--   P1003 — slot_start is not a valid slot boundary within opening hours
--   P1004 — min_notice_hours not respected for a same-day booking
--   P1005 — non-resident booking attempted but not allowed
--   P1006 — capacity exceeded for that exact slot
--   23505 — idempotent retry (spa_bookings_active_slot_per_conversation_idx)
--           — resolved by the TS caller re-reading the existing row, never
--           caught here
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

  -- Serializes concurrent bookings for the EXACT same slot — the capacity
  -- check below is only race-safe because every concurrent transaction
  -- targeting this same (hotel, date, slot) blocks here until the previous
  -- one commits. Salted with a fixed literal prefix so this feature's lock
  -- keyspace can never collide with an unrelated future advisory-lock use
  -- elsewhere in this database.
  perform pg_advisory_xact_lock(hashtextextended('spa_booking:' || p_hotel_id::text || ':' || p_booking_date::text || ':' || p_slot_start::text, 0));

  select coalesce(sum(party_size), 0) into v_current_total
  from public.spa_bookings
  where hotel_id = p_hotel_id and booking_date = p_booking_date and slot_start = p_slot_start and status = 'confirmed';

  if v_current_total + p_party_size > v_settings.capacity_per_slot then
    raise exception 'this slot is fully booked' using errcode = 'P1006';
  end if;

  insert into public.spa_bookings (
    hotel_id, conversation_id, guest_name, guest_phone_e164, party_size, is_non_resident, notes,
    booking_date, slot_start, slot_end, price_per_person_snapshot, status
  ) values (
    p_hotel_id, p_conversation_id, p_guest_name, p_guest_phone_e164, p_party_size, p_is_non_resident, p_notes,
    p_booking_date, p_slot_start, v_slot_end, v_settings.price_per_person, 'confirmed'
  )
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke execute on function public.create_spa_booking(uuid, uuid, text, text, integer, boolean, text, date, time) from public;
revoke execute on function public.create_spa_booking(uuid, uuid, text, text, integer, boolean, text, date, time) from anon;
grant execute on function public.create_spa_booking(uuid, uuid, text, text, integer, boolean, text, date, time) to authenticated, service_role;

-- =========================================================================
-- C. cancel_spa_booking — the ONLY way a spa_bookings row ever moves to
-- 'cancelled'. Same caller-authorization rule as create_spa_booking above.
-- Not reachable from the guest-facing chat flow in this phase (no
-- guest-initiated cancellation) — its only caller is the client-portal
-- "Annuler" action (features/spa/actions.ts), always with p_cancelled_by =
-- 'hotel'; the 'guest'/'system' values exist for a future extension and are
-- validated here so a caller can never pass an arbitrary string.
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
  if v_status <> 'confirmed' then
    raise exception 'spa_booking is not in confirmed status (found %)', v_status using errcode = 'P1008';
  end if;

  update public.spa_bookings
  set status = 'cancelled', cancelled_by = p_cancelled_by, cancelled_at = now()
  where id = p_booking_id;
end;
$$;

revoke execute on function public.cancel_spa_booking(uuid, uuid, text) from public;
revoke execute on function public.cancel_spa_booking(uuid, uuid, text) from anon;
grant execute on function public.cancel_spa_booking(uuid, uuid, text) to authenticated, service_role;

-- =========================================================================
-- D. mark_spa_booking_notification — the ONLY way owner_notification_status/
-- owner_notified_at are ever written after creation. A tiny, dedicated
-- function rather than a partial exception to spa_bookings' own
-- no-direct-write policy, so "no direct UPDATE by any role, ever" remains a
-- true schema-level invariant. Best-effort caller (features/spa/booking.ts):
-- a failure to call this never fails the booking itself.
-- =========================================================================

create or replace function public.mark_spa_booking_notification(
  p_hotel_id uuid,
  p_booking_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
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

  if p_status not in ('sent', 'failed') then
    raise exception 'invalid notification status: %', p_status using errcode = 'P0001';
  end if;

  update public.spa_bookings
  set owner_notification_status = p_status,
      owner_notified_at = case when p_status = 'sent' then now() else owner_notified_at end
  where id = p_booking_id and hotel_id = p_hotel_id;
end;
$$;

revoke execute on function public.mark_spa_booking_notification(uuid, uuid, text) from public;
revoke execute on function public.mark_spa_booking_notification(uuid, uuid, text) from anon;
grant execute on function public.mark_spa_booking_notification(uuid, uuid, text) to authenticated, service_role;
