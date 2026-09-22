-- HUMAN HANDOVER / RAPPEL SMS chantier — PHASE 1, CODE + TESTS ONLY.
-- Additive only. Does NOT modify 0043_hotel_service_requests.sql or
-- 0045_hotel_customers_chatbot_source.sql. NOT applied in this phase.
--
-- Adds exactly what the guest-safe callback-request flow needs:
--  1. hotel_service_requests.guest_phone_e164 — the number the chatbot
--     visitor provided, so staff can call them back. Nullable: existing
--     staff-created rows (0043) never have one.
--  2. Three optional, independently nullable SMS numbers on chatbot_settings
--     for where a handover request gets texted — deliberately separate
--     columns from the pre-existing handoff_phone (a single, PASSIVE number
--     only ever recited to visitors, never used to actively notify staff —
--     see this chantier's own audit; handoff_phone/handoff_email are read,
--     unchanged, only as a FALLBACK contact line when no SMS could be sent).
--  3. A new, minimal, guest-safe SECURITY DEFINER entrypoint,
--     create_hotel_service_request_from_widget — the ONLY way an anonymous
--     chatbot visitor can ever create a row in hotel_service_requests. It
--     hardcodes kind='handover', category='reception', priority='normal',
--     status='open': the caller cannot choose kind/category/priority, cannot
--     target another hotel's data beyond the hotel_id it's given, cannot
--     read/modify/delete anything, and cannot reach any staff function.
--     Granted to service_role ONLY (never anon/authenticated) — reachable
--     exclusively from a trusted Next.js server route that has already
--     resolved hotel_id from a validated widgetKey, never from a
--     client-supplied hotel_id. require_service_request_hotel_user (0043)
--     is NOT modified, NOT weakened, and NOT called by this function.
--  4. A minimal, additive traceability table + SECURITY DEFINER recorder for
--     per-recipient SMS outcomes — never stores a provider message
--     identifier, an auth token, or any content beyond what's needed to
--     distinguish attempted/sent/failed/unknown per configured number.

alter table public.hotel_service_requests
  add column guest_phone_e164 text check (guest_phone_e164 is null or guest_phone_e164 ~ '^\+[1-9][0-9]{7,14}$');

alter table public.chatbot_settings
  add column handover_sms_phone_primary text check (handover_sms_phone_primary is null or handover_sms_phone_primary ~ '^\+[1-9][0-9]{7,14}$'),
  add column handover_sms_phone_secondary text check (handover_sms_phone_secondary is null or handover_sms_phone_secondary ~ '^\+[1-9][0-9]{7,14}$'),
  add column handover_sms_phone_backup text check (handover_sms_phone_backup is null or handover_sms_phone_backup ~ '^\+[1-9][0-9]{7,14}$');

-- One row per (service_request, recipient, attempt) — see
-- record_hotel_service_request_sms_attempt below, the only writer.
create table public.hotel_service_request_sms_attempts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  service_request_id uuid not null,
  recipient_phone_e164 text not null check (recipient_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  status text not null check (status in ('sent', 'failed', 'unknown')),
  created_at timestamptz not null default now(),
  foreign key (service_request_id, hotel_id) references public.hotel_service_requests(id, hotel_id)
);
create index hotel_service_request_sms_attempts_request_idx
  on public.hotel_service_request_sms_attempts(service_request_id, hotel_id, created_at);

alter table public.hotel_service_request_sms_attempts enable row level security;
create policy "authorized hotel reads sms attempts" on public.hotel_service_request_sms_attempts
  for select to authenticated using (public.is_superadmin() or public.is_hotel_admin_for(hotel_id));

-- Same discipline as 0043: no direct writes for anyone, including
-- service_role — only the SECURITY DEFINER functions below write.
revoke all on public.hotel_service_request_sms_attempts from public, anon, authenticated, service_role;
grant select on public.hotel_service_request_sms_attempts to authenticated;

-- GUEST-SAFE ENTRYPOINT. Never calls require_service_request_hotel_user —
-- there is no authenticated user to check for an anonymous chatbot visitor,
-- by design. Its own validation is deliberately minimal: a syntactically
-- valid E.164 phone and a non-empty, bounded guest_message. hotel_id
-- validity is enforced by the existing hotel_service_requests foreign key;
-- conversation_id validity (when provided) by the existing
-- (conversation_id, hotel_id) foreign key already on that table.
create function public.create_hotel_service_request_from_widget(
  p_hotel_id uuid, p_conversation_id uuid, p_guest_phone_e164 text, p_room_number text, p_guest_message text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_guest_phone_e164 is null or p_guest_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid phone' using errcode = '22023';
  end if;
  if p_guest_message is null or char_length(btrim(p_guest_message)) < 1 or char_length(btrim(p_guest_message)) > 2000 then
    raise exception 'invalid message' using errcode = '22023';
  end if;
  if p_room_number is not null and char_length(btrim(p_room_number)) > 200 then
    raise exception 'invalid room number' using errcode = '22023';
  end if;

  insert into public.hotel_service_requests(
    hotel_id, conversation_id, kind, category, priority, status, guest_message, location, guest_phone_e164
  ) values (
    p_hotel_id, p_conversation_id, 'handover', 'reception', 'normal', 'open',
    btrim(p_guest_message), nullif(btrim(p_room_number), ''), p_guest_phone_e164
  ) returning id into v_id;

  insert into public.hotel_service_request_events(
    hotel_id, service_request_id, event_type, actor_type, to_status, message, location, category
  ) values (
    p_hotel_id, v_id, 'created', 'guest', 'open', btrim(p_guest_message), nullif(btrim(p_room_number), ''), 'reception'
  );

  return v_id;
end;
$$;

revoke all on function public.create_hotel_service_request_from_widget(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_hotel_service_request_from_widget(uuid, uuid, text, text, text) to service_role;

create function public.record_hotel_service_request_sms_attempt(
  p_hotel_id uuid, p_service_request_id uuid, p_recipient_phone_e164 text, p_status text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_status not in ('sent', 'failed', 'unknown') then
    raise exception 'invalid status' using errcode = '22023';
  end if;
  insert into public.hotel_service_request_sms_attempts(hotel_id, service_request_id, recipient_phone_e164, status)
    values (p_hotel_id, p_service_request_id, p_recipient_phone_e164, p_status)
    returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_hotel_service_request_sms_attempt(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_hotel_service_request_sms_attempt(uuid, uuid, text, text) to service_role;
