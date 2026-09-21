-- Phase 1 only. Additive, not applied automatically. No transport or chatbot integration.
-- Requires conversations(id, hotel_id), already created by 0020.
-- All mutations require a real authorized user. No service_role/guest entrypoint yet.
create table public.hotel_service_routes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  category text not null check (category in ('technical', 'reception', 'billing', 'internal_alert')),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (hotel_id, category),
  unique (id, hotel_id, category)
);

create table public.hotel_service_requests (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  -- Nullable for a manually recorded request, independent of a chat session.
  conversation_id uuid,
  kind text not null check (kind in ('incident', 'handover')),
  category text not null check (category in ('technical', 'reception', 'billing', 'internal_alert')),
  priority text not null default 'normal' check (priority in ('normal', 'priority', 'urgent')),
  status text not null default 'open' check (status in ('awaiting_guest_info', 'open', 'acknowledged', 'resolved', 'cancelled')),
  guest_message text not null check (char_length(btrim(guest_message)) between 1 and 2000),
  location text check (location is null or char_length(btrim(location)) between 1 and 200),
  assigned_route_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  unique (id, hotel_id),
  foreign key (conversation_id, hotel_id) references public.conversations(id, hotel_id),
  -- Also prevents assigning the wrong category within the same hotel.
  foreign key (assigned_route_id, hotel_id, category) references public.hotel_service_routes(id, hotel_id, category),
  check ((status in ('acknowledged', 'resolved') and acknowledged_at is not null)
    or (status in ('awaiting_guest_info', 'open') and acknowledged_at is null)
    or status = 'cancelled'),
  check ((status = 'resolved') = (resolved_at is not null))
);

create table public.hotel_service_request_events (
  id uuid primary key default gen_random_uuid(),
  -- now() is shared within a transaction: preserve created/assigned ordering.
  event_sequence bigint generated always as identity unique,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  service_request_id uuid not null,
  event_type text not null check (event_type in ('created', 'guest_info_updated', 'opened', 'assigned', 'acknowledged', 'resolved', 'cancelled')),
  actor_type text not null check (actor_type in ('system', 'guest', 'hotel_user')),
  -- Identity snapshot: deliberately not an auth.users FK, so deleting an account
  -- neither deletes history nor prevents account deletion. Never caller supplied.
  actor_user_id uuid,
  from_status text check (from_status in ('awaiting_guest_info', 'open', 'acknowledged', 'resolved', 'cancelled')),
  to_status text not null check (to_status in ('awaiting_guest_info', 'open', 'acknowledged', 'resolved', 'cancelled')),
  message text check (message is null or char_length(btrim(message)) between 1 and 2000),
  location text check (location is null or char_length(btrim(location)) between 1 and 200),
  assigned_route_id uuid,
  category text not null check (category in ('technical', 'reception', 'billing', 'internal_alert')),
  created_at timestamptz not null default now(),
  foreign key (service_request_id, hotel_id) references public.hotel_service_requests(id, hotel_id),
  foreign key (assigned_route_id, hotel_id, category) references public.hotel_service_routes(id, hotel_id, category),
  check ((actor_type = 'hotel_user') = (actor_user_id is not null))
);

create index hotel_service_requests_list_idx on public.hotel_service_requests(hotel_id, created_at desc, id);
create index hotel_service_requests_status_idx on public.hotel_service_requests(hotel_id, status);
create index hotel_service_requests_conversation_idx on public.hotel_service_requests(conversation_id, hotel_id);
create index hotel_service_requests_route_idx on public.hotel_service_requests(assigned_route_id, hotel_id, category);
create index hotel_service_request_events_history_idx on public.hotel_service_request_events(hotel_id, service_request_id, event_sequence);
create index hotel_service_request_events_route_idx on public.hotel_service_request_events(assigned_route_id, hotel_id, category);

create trigger set_updated_at before update on public.hotel_service_routes
  for each row execute function public.set_updated_at();
create trigger set_updated_at before update on public.hotel_service_requests
  for each row execute function public.set_updated_at();

alter table public.hotel_service_routes enable row level security;
alter table public.hotel_service_requests enable row level security;
alter table public.hotel_service_request_events enable row level security;
create policy "authorized hotel reads routes" on public.hotel_service_routes
  for select to authenticated using (public.is_superadmin() or public.is_hotel_admin_for(hotel_id));
create policy "authorized hotel reads requests" on public.hotel_service_requests
  for select to authenticated using (public.is_superadmin() or public.is_hotel_admin_for(hotel_id));
create policy "authorized hotel reads request events" on public.hotel_service_request_events
  for select to authenticated using (public.is_superadmin() or public.is_hotel_admin_for(hotel_id));

-- Explicitly override any Supabase default grants. No direct writes, including
-- service_role: only the SECURITY DEFINER functions below write these tables.
revoke all on public.hotel_service_routes, public.hotel_service_requests, public.hotel_service_request_events
  from public, anon, authenticated, service_role;
grant select on public.hotel_service_routes, public.hotel_service_requests, public.hotel_service_request_events to authenticated;
revoke all on sequence public.hotel_service_request_events_event_sequence_seq from public, anon, authenticated, service_role;

-- Internal authorization primitive, not callable through the Data API.
create function public.require_service_request_hotel_user(p_hotel_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or (auth.jwt() ->> 'role') is distinct from 'authenticated' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not (public.is_superadmin() or public.is_hotel_admin_for(p_hotel_id)) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
revoke all on function public.require_service_request_hotel_user(uuid) from public, anon, authenticated, service_role;

-- One row per category, including inactive rows. Updating a route preserves its
-- identity/category; deactivate rather than delete to preserve request history.
create function public.save_hotel_service_route(
  p_hotel_id uuid, p_route_id uuid, p_category text, p_label text, p_phone_e164 text, p_is_active boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform public.require_service_request_hotel_user(p_hotel_id);
  if p_route_id is null then
    insert into public.hotel_service_routes(hotel_id, category, label, phone_e164, is_active)
      values (p_hotel_id, p_category, btrim(p_label), p_phone_e164, p_is_active) returning id into v_id;
  else
    update public.hotel_service_routes set label = btrim(p_label), phone_e164 = p_phone_e164, is_active = p_is_active
      where id = p_route_id and hotel_id = p_hotel_id and category = p_category returning id into v_id;
    if v_id is null then raise exception 'route not found' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

create function public.create_hotel_service_request(
  p_hotel_id uuid, p_conversation_id uuid, p_kind text, p_category text,
  p_priority text, p_guest_message text, p_location text, p_assigned_route_id uuid,
  p_awaiting_guest_info boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_actor uuid; v_status text;
begin
  v_actor := public.require_service_request_hotel_user(p_hotel_id);
  if p_awaiting_guest_info is null then raise exception 'missing initial state' using errcode = '22023'; end if;
  v_status := case when p_awaiting_guest_info then 'awaiting_guest_info' else 'open' end;
  if p_assigned_route_id is not null then
    -- Lock against concurrent deactivation until the transaction commits.
    perform 1 from public.hotel_service_routes where id = p_assigned_route_id
      and hotel_id = p_hotel_id and category = p_category and is_active for share;
    if not found then raise exception 'active route not found' using errcode = 'P0002'; end if;
  end if;
  insert into public.hotel_service_requests(hotel_id, conversation_id, kind, category, priority,
    status, guest_message, location, assigned_route_id)
    values (p_hotel_id, p_conversation_id, p_kind, p_category, p_priority, v_status,
      btrim(p_guest_message), nullif(btrim(p_location), ''), p_assigned_route_id) returning id into v_id;
  insert into public.hotel_service_request_events(hotel_id, service_request_id, event_type, actor_type,
    actor_user_id, to_status, message, location, category)
    values (p_hotel_id, v_id, 'created', 'hotel_user', v_actor, v_status,
      btrim(p_guest_message), nullif(btrim(p_location), ''), p_category);
  if p_assigned_route_id is not null then
    insert into public.hotel_service_request_events(hotel_id, service_request_id, event_type, actor_type,
      actor_user_id, from_status, to_status, assigned_route_id, category)
      values (p_hotel_id, v_id, 'assigned', 'hotel_user', v_actor, v_status, v_status, p_assigned_route_id, p_category);
  end if;
  return v_id;
end;
$$;

create function public.apply_hotel_service_request_command(
  p_hotel_id uuid, p_request_id uuid, p_command text,
  p_guest_message text default null, p_location text default null, p_route_id uuid default null
) returns void language plpgsql security definer set search_path = '' as $$
declare v_request public.hotel_service_requests%rowtype; v_actor uuid; v_status text; v_event text;
begin
  v_actor := public.require_service_request_hotel_user(p_hotel_id);
  select * into v_request from public.hotel_service_requests
    where id = p_request_id and hotel_id = p_hotel_id for update;
  if not found then raise exception 'request not found' using errcode = 'P0002'; end if;
  if v_request.status in ('resolved', 'cancelled') then
    raise exception 'request is terminal' using errcode = '22023';
  end if;
  if (p_command is distinct from 'update_guest_info' and (p_guest_message is not null or p_location is not null))
    or (p_command is distinct from 'assign' and p_route_id is not null) then
    raise exception 'unexpected command fields' using errcode = '22023';
  end if;
  v_status := v_request.status;
  case p_command
    when 'open' then
      if v_status <> 'awaiting_guest_info' then raise exception 'invalid transition' using errcode = '22023'; end if;
      v_status := 'open'; v_event := 'opened';
    when 'acknowledge' then
      if v_status <> 'open' then raise exception 'invalid transition' using errcode = '22023'; end if;
      v_status := 'acknowledged'; v_event := 'acknowledged';
    when 'resolve' then
      if v_status <> 'acknowledged' then raise exception 'invalid transition' using errcode = '22023'; end if;
      v_status := 'resolved'; v_event := 'resolved';
    when 'cancel' then v_status := 'cancelled'; v_event := 'cancelled';
    when 'update_guest_info' then
      if v_status not in ('awaiting_guest_info', 'open') or p_guest_message is null then
        raise exception 'invalid information update' using errcode = '22023';
      end if;
      v_event := 'guest_info_updated';
    when 'assign' then
      perform 1 from public.hotel_service_routes where id = p_route_id and hotel_id = p_hotel_id
        and category = v_request.category and is_active for share;
      if not found then raise exception 'active route not found' using errcode = 'P0002'; end if;
      if v_request.assigned_route_id = p_route_id then return; end if;
      v_event := 'assigned';
    else raise exception 'unknown command' using errcode = '22023';
  end case;
  update public.hotel_service_requests set status = v_status,
    guest_message = case when p_command = 'update_guest_info' then btrim(p_guest_message) else guest_message end,
    location = case when p_command = 'update_guest_info' then nullif(btrim(p_location), '') else location end,
    assigned_route_id = case when p_command = 'assign' then p_route_id else assigned_route_id end,
    acknowledged_at = case when p_command = 'acknowledge' then now() else acknowledged_at end,
    resolved_at = case when p_command = 'resolve' then now() else resolved_at end
    where id = p_request_id and hotel_id = p_hotel_id;
  insert into public.hotel_service_request_events(hotel_id, service_request_id, event_type, actor_type,
    actor_user_id, from_status, to_status, message, location, assigned_route_id, category)
    values (p_hotel_id, p_request_id, v_event, 'hotel_user', v_actor, v_request.status, v_status,
      case when p_command = 'update_guest_info' then btrim(p_guest_message) end,
      case when p_command = 'update_guest_info' then nullif(btrim(p_location), '') end,
      case when p_command = 'assign' then p_route_id end, v_request.category);
end;
$$;

revoke all on function public.save_hotel_service_route(uuid, uuid, text, text, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.create_hotel_service_request(uuid, uuid, text, text, text, text, text, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function public.apply_hotel_service_request_command(uuid, uuid, text, text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.save_hotel_service_route(uuid, uuid, text, text, text, boolean) to authenticated;
grant execute on function public.create_hotel_service_request(uuid, uuid, text, text, text, text, text, uuid, boolean) to authenticated;
grant execute on function public.apply_hotel_service_request_command(uuid, uuid, text, text, text, uuid) to authenticated;
