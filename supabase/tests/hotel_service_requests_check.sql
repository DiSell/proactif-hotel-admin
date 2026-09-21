-- LOCAL TEST DATABASE ONLY. Run after 0043. Fixtures and assertions roll back.
-- Uses real PostgreSQL roles/RLS/constraints, not application mocks.
begin;
create temporary table service_request_test_results (name text);
grant insert, select on service_request_test_results to authenticated, anon, service_role;
create function pg_temp.service_assert(ok boolean, name text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAILED: %', name; end if;
  insert into service_request_test_results values (name);
end;
$$;
create function pg_temp.service_expect_error(statement text, expected_state text, name text) returns void language plpgsql as $$
declare actual_state text;
begin
  begin
    execute statement;
  exception when others then actual_state := sqlstate;
  end;
  -- Assertion is OUTSIDE the exception handler, so it cannot swallow itself.
  perform pg_temp.service_assert(actual_state = expected_state, name || ' (expected ' || expected_state || ', got ' || coalesce(actual_state, 'success') || ')');
end;
$$;

do $$
declare
  ha uuid; hb uuid; ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  us uuid := gen_random_uuid(); unrelated uuid := gen_random_uuid();
  ca uuid; cb uuid; ra uuid; rb uuid; inactive_route uuid; reception_route uuid;
  qa uuid; qb uuid; waiting uuid; cancelled uuid;
  request_count integer; event_count integer; v text; field text; command text;
begin
  insert into public.hotels(name, slug, widget_key) values ('SR Test A', 'sr-' || ua, 'sr-' || ua) returning id into ha;
  insert into public.hotels(name, slug, widget_key) values ('SR Test B', 'sr-' || ub, 'sr-' || ub) returning id into hb;
  insert into auth.users(id, email) values (ua, ua || '@example.invalid'), (ub, ub || '@example.invalid'),
    (us, us || '@example.invalid'), (unrelated, unrelated || '@example.invalid');
  insert into public.profiles(id, email, role) values (ua, ua || '@example.invalid', 'hotel_admin'),
    (ub, ub || '@example.invalid', 'hotel_admin'), (us, us || '@example.invalid', 'superadmin'),
    (unrelated, unrelated || '@example.invalid', 'hotel_admin');
  insert into public.hotel_users(hotel_id, user_id) values (ha, ua), (hb, ub);
  insert into public.conversations(hotel_id, session_id) values (ha, 'sr-a') returning id into ca;
  insert into public.conversations(hotel_id, session_id) values (hb, 'sr-b') returning id into cb;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', ub)::text, true);
  rb := public.save_hotel_service_route(hb, null, 'technical', 'Maintenance B', '+33600000002', true);
  qb := public.create_hotel_service_request(hb, cb, 'incident', 'technical', 'normal', 'B leak', '204', rb, false);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', ua)::text, true);
  ra := public.save_hotel_service_route(ha, null, 'technical', 'Maintenance A', '+33600000001', true);
  inactive_route := public.save_hotel_service_route(ha, null, 'billing', 'Direction', '+33600000003', false);
  reception_route := public.save_hotel_service_route(ha, null, 'reception', 'Reception', '+33600000004', true);
  qa := public.create_hotel_service_request(ha, ca, 'incident', 'technical', 'priority', 'A leak', 'Piscine', ra, false);
  perform pg_temp.service_assert((select status = 'open' and location = 'Piscine' from public.hotel_service_requests where id = qa), 'A: authorized creation');
  perform pg_temp.service_assert((select count(*) = 2 from public.hotel_service_request_events where service_request_id = qa), 'I: creation and assignment events');
  perform pg_temp.service_assert((select array_agg(event_type order by event_sequence) = array['created', 'assigned'] from public.hotel_service_request_events where service_request_id = qa), 'I: stable ordering within same transaction');
  perform pg_temp.service_assert((select bool_and(actor_type = 'hotel_user' and actor_user_id = ua) from public.hotel_service_request_events where service_request_id = qa), 'I: actor from authenticated session');

  perform pg_temp.service_assert((select count(*) = 0 from public.hotel_service_requests where id = qb), 'B: cross-hotel request read hidden');
  perform pg_temp.service_assert((select count(*) = 0 from public.hotel_service_routes where id = rb), 'B: cross-hotel route phone hidden');
  perform pg_temp.service_assert((select count(*) = 0 from public.hotel_service_request_events where service_request_id = qb), 'B: cross-hotel events hidden');
  foreach command in array array['acknowledge', 'resolve'] loop
    perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,%L)', hb, qb, command), '42501', 'C: cannot authorize other hotel ' || command);
    perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,%L)', ha, qb, command), 'P0002', 'C: cannot use other request under own hotel ' || command);
  end loop;
  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,%L,''incident'',''technical'',''normal'',''x'',null,null,false)', hb, cb), '42501', 'A: cannot create in another hotel');
  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,%L,''incident'',''technical'',''normal'',''x'',null,%L,false)', ha, ca, rb), 'P0002', 'D: cross-hotel route rejected by create RPC');
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''assign'',null,null,%L)', ha, qa, rb), 'P0002', 'D: cross-hotel route rejected by assign RPC');
  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,%L,''incident'',''technical'',''normal'',''x'',null,null,false)', ha, cb), '23503', 'E: composite conversation FK');
  perform pg_temp.service_expect_error(format('select public.save_hotel_service_route(%L,%L,''technical'',''X'',''+33600000009'',true)', ha, rb), 'P0002', 'D: cannot edit another hotel route');
  perform pg_temp.service_expect_error(format('select public.save_hotel_service_route(%L,null,''technical'',''X'',''+33600000009'',true)', ha), '23505', 'route category uniqueness');
  perform pg_temp.service_expect_error(format('select public.save_hotel_service_route(%L,%L,''billing'',''X'',''+33600000009'',true)', ha, ra), 'P0002', 'route category immutable');
  perform pg_temp.service_expect_error(format('select public.save_hotel_service_route(%L,%L,''technical'',''X'',''0600000009'',true)', ha, ra), '23514', 'route E164 validation');

  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,null,''handover'',''billing'',''normal'',''x'',null,%L,false)', ha, inactive_route), 'P0002', 'H: inactive route rejected at creation');
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''assign'',null,null,%L)', ha, qa, reception_route), 'P0002', 'wrong category route rejected');
  perform public.save_hotel_service_route(ha, ra, 'technical', 'Maintenance A', '+33600000001', false);
  perform pg_temp.service_assert((select assigned_route_id = ra from public.hotel_service_requests where id = qa), 'H: deactivation preserves historical assignment');
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''assign'',null,null,%L)', ha, qa, ra), 'P0002', 'H: inactive route rejected at assignment');
  perform public.save_hotel_service_route(ha, ra, 'technical', 'Maintenance A', '+33600000001', true);
  select count(*) into event_count from public.hotel_service_request_events where service_request_id = qa;
  perform public.apply_hotel_service_request_command(ha, qa, 'assign', null, null, ra);
  perform pg_temp.service_assert((select count(*) = event_count from public.hotel_service_request_events where service_request_id = qa), 'same assignment is a no-op');

  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''resolve'')', ha, qa), '22023', 'F: open cannot skip acknowledgment');
  perform public.apply_hotel_service_request_command(ha, qa, 'acknowledge');
  perform pg_temp.service_assert((select status = 'acknowledged' and acknowledged_at is not null and resolved_at is null from public.hotel_service_requests where id = qa), 'F: open to acknowledged');
  perform public.apply_hotel_service_request_command(ha, qa, 'resolve');
  perform pg_temp.service_assert((select status = 'resolved' and resolved_at is not null and acknowledged_at is not null from public.hotel_service_requests where id = qa), 'F: acknowledged to resolved');
  foreach command in array array['open', 'acknowledge', 'resolve', 'cancel', 'update_guest_info', 'assign'] loop
    perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,%L)', ha, qa, command), '22023', 'F: resolved rejects ' || command);
  end loop;
  perform pg_temp.service_assert((select count(*) = 4 from public.hotel_service_request_events where service_request_id = qa), 'I: failed transitions leave no events');
  perform pg_temp.service_assert((select count(*) = 1 from public.hotel_service_request_events where service_request_id = qa and event_type = 'resolved' and from_status = 'acknowledged' and to_status = 'resolved'), 'I: resolution history');

  waiting := public.create_hotel_service_request(ha, null, 'handover', 'reception', 'normal', 'Reception please', null, null, true);
  perform pg_temp.service_assert((select conversation_id is null and status = 'awaiting_guest_info' from public.hotel_service_requests where id = waiting), 'manual request without conversation');
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''acknowledge'')', ha, waiting), '22023', 'F: awaiting cannot skip open');
  perform public.apply_hotel_service_request_command(ha, waiting, 'update_guest_info', 'More details', 'Parking');
  perform pg_temp.service_assert((select status = 'awaiting_guest_info' and guest_message = 'More details' and location = 'Parking' from public.hotel_service_requests where id = waiting), 'guest information update does not imply readiness');
  perform pg_temp.service_assert((select count(*) = 1 from public.hotel_service_request_events where service_request_id = waiting and event_type = 'guest_info_updated' and message = 'More details' and location = 'Parking'), 'I: information snapshot');
  perform public.apply_hotel_service_request_command(ha, waiting, 'open');
  perform public.apply_hotel_service_request_command(ha, waiting, 'assign', null, null, reception_route);
  perform pg_temp.service_assert((select status = 'open' and assigned_route_id = reception_route from public.hotel_service_requests where id = waiting), 'F: awaiting to open and assignment');
  perform pg_temp.service_assert((select count(*) = 1 from public.hotel_service_request_events where service_request_id = waiting and event_type = 'opened'), 'I: opened event');

  foreach v in array array['awaiting_guest_info', 'open', 'acknowledged'] loop
    cancelled := public.create_hotel_service_request(ha, null, 'incident', 'technical', 'normal', 'Cancel test', null, null, v = 'awaiting_guest_info');
    if v = 'acknowledged' then perform public.apply_hotel_service_request_command(ha, cancelled, 'acknowledge'); end if;
    perform public.apply_hotel_service_request_command(ha, cancelled, 'cancel');
    perform pg_temp.service_assert((select status = 'cancelled' and resolved_at is null from public.hotel_service_requests where id = cancelled), 'F: cancellation from ' || v);
    perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''acknowledge'')', ha, cancelled), '22023', 'F: cancelled rejects acknowledgment (' || v || ')');
  end loop;
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''sent'')', ha, waiting), '22023', 'no transport command');
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''acknowledge'',''forged info'')', ha, waiting), '22023', 'unexpected command payload rejected');
  select count(*) into request_count from public.hotel_service_requests;
  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,null,''invalid'',''technical'',''normal'',''x'',null,null,false)', ha), '23514', 'G: invalid kind');
  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,null,''incident'',''technical'',''critical'',''x'',null,null,false)', ha), '23514', 'G: invalid priority');
  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,null,''incident'',''restaurant'',''normal'',''x'',null,null,false)', ha), '23514', 'G: invalid category');
  perform pg_temp.service_assert((select count(*) = request_count from public.hotel_service_requests), 'invalid creations roll back');

  -- No direct writes for hotel users, even within their own hotel.
  perform pg_temp.service_expect_error(format('update public.hotel_service_requests set status = ''resolved'' where id = %L', waiting), '42501', 'direct state forgery denied');
  perform pg_temp.service_expect_error(format('insert into public.hotel_service_request_events(hotel_id,service_request_id,event_type,actor_type,to_status,category) values (%L,%L,''resolved'',''system'',''resolved'',''technical'')', hb, qb), '42501', 'cross-hotel event injection denied');
  perform pg_temp.service_expect_error('delete from public.hotel_service_request_events', '42501', 'event deletion denied');
  perform pg_temp.service_expect_error('update public.hotel_service_routes set is_active = false', '42501', 'direct route mutation denied');

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', unrelated)::text, true);
  perform pg_temp.service_assert((select count(*) = 0 from public.hotel_service_requests), 'unlinked user cannot read');
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''acknowledge'')', ha, waiting), '42501', 'unlinked user cannot mutate');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', us)::text, true);
  perform pg_temp.service_assert((select count(*) = 2 from public.hotel_service_requests where id in (qa,qb)), 'superadmin can read both hotels');
  perform public.apply_hotel_service_request_command(hb, qb, 'acknowledge');
  perform pg_temp.service_assert((select actor_user_id = us from public.hotel_service_request_events where service_request_id = qb and event_type = 'acknowledged'), 'superadmin action attributed');

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform pg_temp.service_expect_error('select * from public.hotel_service_routes', '42501', 'anon cannot read private phone');
  perform pg_temp.service_expect_error(format('select public.create_hotel_service_request(%L,null,''incident'',''technical'',''normal'',''x'',null,null,false)', ha), '42501', 'anon cannot create');
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform pg_temp.service_expect_error(format('select public.apply_hotel_service_request_command(%L,%L,''acknowledge'')', ha, waiting), '42501', 'service_role cannot impersonate human');
  perform pg_temp.service_expect_error('update public.hotel_service_requests set status = ''open''', '42501', 'service_role direct write denied');

  -- Test constraints independently of RPC checks as the local database owner.
  perform set_config('role', 'none', true);
  perform pg_temp.service_expect_error(format('insert into public.hotel_service_requests(hotel_id,kind,category,guest_message,assigned_route_id) values (%L,''incident'',''technical'',''x'',%L)', ha, rb), '23503', 'D: DB composite route FK independent of application');
  perform pg_temp.service_expect_error(format('insert into public.hotel_service_request_events(hotel_id,service_request_id,event_type,actor_type,to_status,category) values (%L,%L,''created'',''system'',''open'',''technical'')', ha, qb), '23503', 'DB composite event request FK');
  perform pg_temp.service_expect_error(format('insert into public.hotel_service_request_events(hotel_id,service_request_id,event_type,actor_type,to_status,category,assigned_route_id) values (%L,%L,''assigned'',''system'',''open'',''technical'',%L)', ha, waiting, rb), '23503', 'DB composite event route FK');
  foreach field in array array['priority', 'status'] loop
    perform pg_temp.service_expect_error(format('insert into public.hotel_service_requests(hotel_id,kind,category,guest_message,%I) values (%L,''incident'',''technical'',''x'',''invalid'')', field, ha),
      '23514', 'G: raw DB invalid ' || field);
  end loop;
  -- Explicit kind/category checks without duplicate SQL columns.
  perform pg_temp.service_expect_error(format('insert into public.hotel_service_requests(hotel_id,kind,category,guest_message) values (%L,''invalid'',''technical'',''x'')', ha), '23514', 'G: raw kind constraint');
  perform pg_temp.service_expect_error(format('insert into public.hotel_service_requests(hotel_id,kind,category,guest_message) values (%L,''incident'',''invalid'',''x'')', ha), '23514', 'G: raw category constraint');
  perform pg_temp.service_expect_error(format('insert into public.hotel_service_requests(hotel_id,kind,category,guest_message,status) values (%L,''incident'',''technical'',''x'',''resolved'')', ha), '23514', 'resolution timestamp invariant');
end;
$$;
select count(*) as passed_assertions from service_request_test_results;
rollback;
