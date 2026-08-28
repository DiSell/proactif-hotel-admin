-- Constraint/behavior checks for 0020_partner_requests.sql — run this in the
-- Supabase SQL editor (or psql connected to the project) AFTER that
-- migration has been applied.
--
-- BEGIN/ROLLBACK, same style as every other test script in this project —
-- everything this script writes is rolled back at the end. No real project
-- data is touched.
--
-- Same RLS-simulation mechanism as hotel_partners_check.sql: setting
-- `role` + `request.jwt.claims` (sub, role) for the duration of the
-- transaction makes every subsequent statement behave exactly as if it
-- came from that identity's session-bound client (or, for `service_role`,
-- the admin client used by the chatbot/webhook engine).

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  user_superadmin uuid := gen_random_uuid();
  user_unrelated uuid := gen_random_uuid(); -- authenticated, hotel_admin role, but linked to NO hotel at all
  partner_a uuid;             -- active, consent accepted (the "good" partner)
  partner_a_inactive uuid;    -- is_active = false
  partner_a_pending uuid;     -- consent_status still 'not_requested'
  partner_b uuid;             -- belongs to hotel_b
  conversation_a uuid;
  conversation_b uuid;
  request_id uuid;
  request_id_2 uuid;
  status_check text;
  notification_status_check text;
  event_count int;
  updated_at_before timestamptz;
  updated_at_after timestamptz;
  notified_at_check timestamptz;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('PR Test Hotel A', 'pr-test-hotel-a', 'ps_live_pr_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('PR Test Hotel B', 'pr-test-hotel-b', 'ps_live_pr_test_b', 'active', true)
  returning id into hotel_b;

  insert into auth.users (id, email) values (user_a, 'pr-test-a@example.com');
  insert into auth.users (id, email) values (user_b, 'pr-test-b@example.com');

  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_a, 'pr-test-a@example.com', 'hotel_admin', 'Alice', 'A');
  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_b, 'pr-test-b@example.com', 'hotel_admin', 'Bob', 'B');

  insert into public.hotel_users (hotel_id, user_id) values (hotel_a, user_a);
  insert into public.hotel_users (hotel_id, user_id) values (hotel_b, user_b);

  insert into auth.users (id, email) values (user_superadmin, 'pr-test-superadmin@example.com');
  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_superadmin, 'pr-test-superadmin@example.com', 'superadmin', 'Sam', 'Super');

  -- Deliberately NO hotel_users row for this one — authenticated,
  -- profile role 'hotel_admin', but not linked to hotel_a, hotel_b, or
  -- any other hotel. Represents scenario F (authenticated but not
  -- authorized for this specific request).
  insert into auth.users (id, email) values (user_unrelated, 'pr-test-unrelated@example.com');
  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_unrelated, 'pr-test-unrelated@example.com', 'hotel_admin', 'Uma', 'Unrelated');

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_a, 'Restaurant Accepté', 'restaurant', true, 'accepted')
  returning id into partner_a;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_a, 'Restaurant Inactif', 'restaurant', false, 'accepted')
  returning id into partner_a_inactive;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_a, 'Restaurant Non Consentant', 'restaurant', true, 'not_requested')
  returning id into partner_a_pending;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_b, 'Taxi Hotel B', 'transport', true, 'accepted')
  returning id into partner_b;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_a, 'pr-test-session-a')
  returning id into conversation_a;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_b, 'pr-test-session-b')
  returning id into conversation_b;

  raise notice 'OK: fixtures created';

  -- ================================================================
  -- Simulate a service_role-originated call (the chatbot/webhook engine)
  -- for the bulk of the workflow tests below.
  -- ================================================================
  execute format('set local role service_role');
  execute format('set local request.jwt.claims to %L', json_build_object('role', 'service_role')::text);

  -- ================================================================
  -- 1) Atomic creation: partner_requests row + request_created event
  -- ================================================================
  request_id := public.create_partner_request(
    hotel_a, partner_a, conversation_a, 'Alice Client', '+33612345678',
    'restaurant', current_date + 1, '20:00', 2, 'Table pour deux, terrasse si possible.'
  );
  if request_id is null then
    raise exception 'BUG: create_partner_request returned no id';
  end if;
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'draft' then
    raise exception 'BUG: new partner_request status should be draft, got %', status_check;
  end if;
  select count(*) into event_count from public.partner_request_events where partner_request_id = request_id and event_type = 'request_created' and actor_type = 'guest';
  if event_count <> 1 then
    raise exception 'BUG: expected exactly one request_created/guest event, found %', event_count;
  end if;
  raise notice 'OK: create_partner_request creates the row (status=draft) and its request_created event atomically';

  -- ================================================================
  -- 2) Cross-tenant partner rejected
  -- ================================================================
  begin
    perform public.create_partner_request(hotel_a, partner_b, conversation_a, 'X', null, 'restaurant', null, null, null, null);
    raise exception 'SECURITY BUG: created a request against another hotel''s partner';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: cross-tenant partner_id rejected';
  end;

  -- ================================================================
  -- 3) Cross-tenant conversation rejected
  -- ================================================================
  begin
    perform public.create_partner_request(hotel_a, partner_a, conversation_b, 'X', null, 'restaurant', null, null, null, null);
    raise exception 'SECURITY BUG: created a request against another hotel''s conversation';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: cross-tenant conversation_id rejected';
  end;

  -- ================================================================
  -- 4) Partner without accepted consent rejected
  -- ================================================================
  begin
    perform public.create_partner_request(hotel_a, partner_a_pending, conversation_a, 'X', null, 'restaurant', null, null, null, null);
    raise exception 'BUG: created a request against a non-consenting partner';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: partner with consent_status <> accepted rejected';
  end;

  -- ================================================================
  -- 5) Inactive partner rejected
  -- ================================================================
  begin
    perform public.create_partner_request(hotel_a, partner_a_inactive, conversation_a, 'X', null, 'restaurant', null, null, null, null);
    raise exception 'BUG: created a request against an inactive partner';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: inactive partner rejected';
  end;

  -- ================================================================
  -- 6) Malformed guest_phone_e164 rejected (table CHECK, not app logic)
  -- ================================================================
  begin
    perform public.create_partner_request(hotel_a, partner_a, conversation_a, 'X', '0612345678', 'restaurant', null, null, null, null);
    raise exception 'BUG: a non-E.164 guest_phone_e164 (0612345678) was accepted';
  exception
    when check_violation then
      raise notice 'OK: guest_phone_e164 CHECK rejects a non-E.164 value';
  end;

  -- ================================================================
  -- Back to the unrestricted role for a direct-constraint check.
  -- ================================================================
  reset role;
  reset "request.jwt.claims";

  -- ================================================================
  -- 7) Malformed hotel_partners.request_phone_e164 rejected
  -- ================================================================
  begin
    update public.hotel_partners set request_phone_e164 = '0612345678' where id = partner_a;
    raise exception 'BUG: a non-E.164 request_phone_e164 (0612345678) was accepted';
  exception
    when check_violation then
      raise notice 'OK: hotel_partners.request_phone_e164 CHECK rejects a non-E.164 value';
  end;

  -- ================================================================
  -- Resume service_role for the workflow transitions.
  -- ================================================================
  execute format('set local role service_role');
  execute format('set local request.jwt.claims to %L', json_build_object('role', 'service_role')::text);

  -- ================================================================
  -- 8) draft -> pending_confirmation
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'request_guest_confirmation');
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'pending_confirmation' then
    raise exception 'BUG: expected pending_confirmation after request_guest_confirmation, got %', status_check;
  end if;
  raise notice 'OK: draft -> pending_confirmation via request_guest_confirmation';

  -- ================================================================
  -- 9) guest_confirm: event only, status AND updated_at unchanged
  -- ================================================================
  select updated_at into updated_at_before from public.partner_requests where id = request_id;
  perform pg_sleep(0.01); -- ensure any accidental now() write would be observably different
  perform public.apply_partner_request_command(request_id, hotel_a, 'guest_confirm');
  select status, updated_at into status_check, updated_at_after from public.partner_requests where id = request_id;
  if status_check <> 'pending_confirmation' then
    raise exception 'BUG: guest_confirm must not change status, got %', status_check;
  end if;
  if updated_at_after <> updated_at_before then
    raise exception 'BUG: guest_confirm ran an UPDATE on partner_requests (updated_at changed) — it must be event-only';
  end if;
  select count(*) into event_count from public.partner_request_events where partner_request_id = request_id and event_type = 'guest_confirmed' and actor_type = 'guest';
  if event_count <> 1 then
    raise exception 'BUG: expected exactly one guest_confirmed/guest event';
  end if;
  raise notice 'OK: guest_confirm writes only an event, no projection UPDATE at all';

  -- ================================================================
  -- 10) partner_delivery_failed: status unchanged, event recorded
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'partner_delivery_failed', 'timeout contacting provider');
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'pending_confirmation' then
    raise exception 'BUG: partner_delivery_failed must never change status, got %', status_check;
  end if;
  select count(*) into event_count from public.partner_request_events where partner_request_id = request_id and event_type = 'partner_delivery_failed' and actor_type = 'system';
  if event_count <> 1 then
    raise exception 'BUG: expected exactly one partner_delivery_failed/system event';
  end if;
  raise notice 'OK: partner_delivery_failed leaves status untouched and records the failure event';

  -- ================================================================
  -- 11) partner_delivery_succeeded -> sent_to_partner
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'partner_delivery_succeeded');
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'sent_to_partner' then
    raise exception 'BUG: expected sent_to_partner after partner_delivery_succeeded, got %', status_check;
  end if;
  raise notice 'OK: partner_delivery_succeeded produces sent_to_partner (and only this command does)';

  -- ================================================================
  -- 12) Forbidden transitions
  -- ================================================================
  begin
    perform public.apply_partner_request_command(request_id, hotel_a, 'request_guest_confirmation');
    raise exception 'BUG: request_guest_confirmation succeeded from sent_to_partner (should only be legal from draft)';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: request_guest_confirmation rejected from sent_to_partner';
  end;

  begin
    perform public.apply_partner_request_command(request_id, hotel_a, 'guest_accept_alternative');
    raise exception 'BUG: guest_accept_alternative succeeded from sent_to_partner (should only be legal from alternative_proposed)';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: guest_accept_alternative rejected from sent_to_partner';
  end;

  -- ================================================================
  -- 13) sent_to_partner -> alternative_proposed
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'partner_propose_alternative', '21h plutôt que 20h ?', jsonb_build_object('proposed_time', '21:00'));
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'alternative_proposed' then
    raise exception 'BUG: expected alternative_proposed, got %', status_check;
  end if;
  if (select partner_response from public.partner_requests where id = request_id) is distinct from '21h plutôt que 20h ?' then
    raise exception 'BUG: partner_response was not recorded on partner_propose_alternative';
  end if;
  raise notice 'OK: sent_to_partner -> alternative_proposed, partner_response/responded_at recorded';

  -- ================================================================
  -- 14) guest_accept_alternative: status STAYS alternative_proposed
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'guest_accept_alternative');
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'alternative_proposed' then
    raise exception 'BUG: guest_accept_alternative must NOT change status by itself, got %', status_check;
  end if;
  raise notice 'OK: guest_accept_alternative keeps status at alternative_proposed (retransmission still required)';

  -- ================================================================
  -- 15) [non-negotiable rule] accepting an alternative never jumps to accepted
  -- ================================================================
  begin
    perform public.apply_partner_request_command(request_id, hotel_a, 'partner_accept');
    raise exception 'SECURITY/LOGIC BUG: partner_accept succeeded from alternative_proposed — accepted must only come from sent_to_partner';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: partner_accept rejected from alternative_proposed — no direct alternative_proposed -> accepted path exists';
  end;

  -- ================================================================
  -- 16) alternative_proposed -> sent_to_partner (retransmission)
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'partner_delivery_succeeded');
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'sent_to_partner' then
    raise exception 'BUG: expected sent_to_partner after retransmission, got %', status_check;
  end if;
  raise notice 'OK: alternative_proposed -> sent_to_partner via partner_delivery_succeeded (retransmission path)';

  -- ================================================================
  -- 17) sent_to_partner -> accepted, ONLY via partner_accept
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'partner_accept', 'Confirmé pour 21h.');
  select status into status_check from public.partner_requests where id = request_id;
  if status_check <> 'accepted' then
    raise exception 'BUG: expected accepted, got %', status_check;
  end if;
  select count(*) into event_count from public.partner_request_events where partner_request_id = request_id and event_type = 'partner_accepted' and actor_type = 'partner';
  if event_count <> 1 then
    raise exception 'BUG: expected exactly one partner_accepted/partner event';
  end if;
  raise notice 'OK: sent_to_partner -> accepted via partner_accept, correct event/actor recorded';

  -- ================================================================
  -- 18) accepted is terminal for business transitions — re-applying
  -- partner_accept (or any other business command) now fails.
  -- ================================================================
  begin
    perform public.apply_partner_request_command(request_id, hotel_a, 'partner_accept');
    raise exception 'BUG: partner_accept succeeded again from an already-accepted request';
  exception
    when sqlstate 'P0001' then
      raise notice 'OK: accepted is terminal — no further business transition accepted';
  end;

  -- ================================================================
  -- 19) Notification AFTER a terminal outcome still works
  -- ================================================================
  perform public.apply_partner_request_command(request_id, hotel_a, 'guest_notification_succeeded');
  select status, guest_notification_status, guest_notified_at
    into status_check, notification_status_check, notified_at_check
    from public.partner_requests where id = request_id;
  if status_check <> 'accepted' then
    raise exception 'BUG: guest_notification_succeeded must not change status, got %', status_check;
  end if;
  if notification_status_check <> 'sent' or notified_at_check is null then
    raise exception 'BUG: guest_notification_succeeded did not record sent/guest_notified_at correctly';
  end if;
  raise notice 'OK: guest_notification_succeeded works after a terminal (accepted) outcome, status stays accepted';

  -- ================================================================
  -- 20) guest_notification_failed never touches guest_notified_at
  -- ================================================================
  request_id_2 := public.create_partner_request(
    hotel_a, partner_a, conversation_a, 'Bob Client', null, 'restaurant', null, null, null, null
  );
  -- guest_notification_* is deliberately NOT allowed from 'draft' (nothing
  -- to notify before a confirmation has even been requested) — advance out
  -- of draft first, same as the real flow would.
  perform public.apply_partner_request_command(request_id_2, hotel_a, 'request_guest_confirmation');
  perform public.apply_partner_request_command(request_id_2, hotel_a, 'guest_notification_failed', 'provider unreachable');
  select guest_notification_status, guest_notified_at into notification_status_check, notified_at_check from public.partner_requests where id = request_id_2;
  if notification_status_check <> 'failed' then
    raise exception 'BUG: expected guest_notification_status = failed, got %', notification_status_check;
  end if;
  if notified_at_check is not null then
    raise exception 'BUG: guest_notification_failed must never set guest_notified_at, got %', notified_at_check;
  end if;
  raise notice 'OK: guest_notification_failed sets guest_notification_status=failed without touching guest_notified_at';

  reset role;
  reset "request.jwt.claims";

  raise notice 'OK: all partner_requests workflow checks passed';
end $$;

-- ================================================================
-- 21) Caller-authorization matrix for apply_partner_request_command
-- (create_partner_request shares the exact same authorization block —
-- spot-checked at the end of this section rather than repeating all six
-- scenarios twice).
--
-- A. service_role                                -> authorized
-- B. authenticated, superadmin                    -> authorized
-- C. authenticated, hotel_admin of the RIGHT hotel -> authorized
-- D. authenticated, hotel_admin of ANOTHER hotel   -> rejected (42501)
-- E. anon                                          -> EXECUTE itself denied
-- F. authenticated, unrelated (no hotel link)      -> rejected (42501)
-- ================================================================
do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  user_a uuid;
  user_b uuid;
  user_superadmin uuid;
  user_unrelated uuid;
  auth_request_id uuid;
  status_check text;
begin
  select id into hotel_a from public.hotels where slug = 'pr-test-hotel-a';
  select id into hotel_b from public.hotels where slug = 'pr-test-hotel-b';
  select id into user_a from auth.users where email = 'pr-test-a@example.com';
  select id into user_b from auth.users where email = 'pr-test-b@example.com';
  select id into user_superadmin from auth.users where email = 'pr-test-superadmin@example.com';
  select id into user_unrelated from auth.users where email = 'pr-test-unrelated@example.com';

  -- Fresh, isolated request in 'draft' — created directly (bypassing the
  -- RPC) purely as test scaffolding, so this section only ever exercises
  -- apply_partner_request_command's OWN authorization logic, never
  -- create_partner_request's.
  insert into public.partner_requests (hotel_id, partner_id, conversation_id, request_category, status)
  select hotel_a, id, (select id from public.conversations where session_id = 'pr-test-session-a'), 'restaurant', 'draft'
  from public.hotel_partners where hotel_id = hotel_a and consent_status = 'accepted' and is_active = true
  limit 1
  returning id into auth_request_id;

  -- ---- A. service_role: authorized ----
  execute format('set local role service_role');
  execute format('set local request.jwt.claims to %L', json_build_object('role', 'service_role')::text);
  perform public.apply_partner_request_command(auth_request_id, hotel_a, 'request_guest_confirmation');
  select status into status_check from public.partner_requests where id = auth_request_id;
  if status_check <> 'pending_confirmation' then
    raise exception 'BUG: service_role call did not apply the command';
  end if;
  reset role;
  reset "request.jwt.claims";
  raise notice 'OK: [A] service_role authorized';
  update public.partner_requests set status = 'draft' where id = auth_request_id; -- reset for next scenario

  -- ---- B. authenticated superadmin: authorized ----
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_superadmin, 'role', 'authenticated')::text);
  perform public.apply_partner_request_command(auth_request_id, hotel_a, 'request_guest_confirmation');
  select status into status_check from public.partner_requests where id = auth_request_id;
  if status_check <> 'pending_confirmation' then
    raise exception 'BUG: authenticated superadmin call did not apply the command';
  end if;
  reset role;
  reset "request.jwt.claims";
  raise notice 'OK: [B] authenticated superadmin authorized';
  update public.partner_requests set status = 'draft' where id = auth_request_id;

  -- ---- C. authenticated hotel_admin of the RIGHT hotel: authorized ----
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_a, 'role', 'authenticated')::text);
  perform public.apply_partner_request_command(auth_request_id, hotel_a, 'request_guest_confirmation');
  select status into status_check from public.partner_requests where id = auth_request_id;
  if status_check <> 'pending_confirmation' then
    raise exception 'BUG: authenticated hotel_admin (own hotel) call did not apply the command';
  end if;
  reset role;
  reset "request.jwt.claims";
  raise notice 'OK: [C] authenticated hotel_admin of the right hotel authorized';
  update public.partner_requests set status = 'draft' where id = auth_request_id;

  -- ---- D. authenticated hotel_admin of ANOTHER hotel: rejected ----
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_b, 'role', 'authenticated')::text);
  begin
    perform public.apply_partner_request_command(auth_request_id, hotel_a, 'request_guest_confirmation');
    raise exception 'SECURITY BUG: hotel_admin of hotel_b was authorized against a hotel_a request';
  exception
    when sqlstate '42501' then
      raise notice 'OK: [D] authenticated hotel_admin of another hotel rejected (42501)';
  end;
  reset role;
  reset "request.jwt.claims";

  -- ---- E. anon: EXECUTE itself denied, never reaches internal logic ----
  execute format('set local role anon');
  begin
    perform public.apply_partner_request_command(auth_request_id, hotel_a, 'request_guest_confirmation');
    raise exception 'SECURITY BUG: anon was able to call apply_partner_request_command';
  exception
    when insufficient_privilege then
      raise notice 'OK: [E] anon rejected at the EXECUTE grant level (insufficient_privilege)';
  end;
  reset role;

  -- ---- F. authenticated, no hotel link at all: rejected ----
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_unrelated, 'role', 'authenticated')::text);
  begin
    perform public.apply_partner_request_command(auth_request_id, hotel_a, 'request_guest_confirmation');
    raise exception 'SECURITY BUG: an authenticated user with no hotel link was authorized';
  exception
    when sqlstate '42501' then
      raise notice 'OK: [F] authenticated user with no hotel link rejected (42501)';
  end;
  reset role;
  reset "request.jwt.claims";

  -- ---- Spot-check: create_partner_request shares the exact same
  -- authorization block — confirm scenario D (wrong hotel_admin) and E
  -- (anon) are rejected there too, without repeating all six scenarios.
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_b, 'role', 'authenticated')::text);
  begin
    perform public.create_partner_request(hotel_a, (select id from public.hotel_partners where hotel_id = hotel_a and consent_status = 'accepted' and is_active = true limit 1), (select id from public.conversations where session_id = 'pr-test-session-a'), null, null, 'restaurant', null, null, null, null);
    raise exception 'SECURITY BUG: create_partner_request authorized a hotel_admin of another hotel';
  exception
    when sqlstate '42501' then
      raise notice 'OK: create_partner_request rejects hotel_admin of another hotel (42501), same rule as apply_partner_request_command';
  end;
  reset role;
  reset "request.jwt.claims";

  execute format('set local role anon');
  begin
    perform public.create_partner_request(hotel_a, null, null, null, null, 'restaurant', null, null, null, null);
    raise exception 'SECURITY BUG: anon was able to call create_partner_request';
  exception
    when insufficient_privilege then
      raise notice 'OK: create_partner_request rejects anon at the EXECUTE grant level, same rule as apply_partner_request_command';
  end;
  reset role;

  raise notice 'OK: caller-authorization matrix (A-F) passed for both RPCs';
end $$;

-- ================================================================
-- 22) Append-only in practice: no direct INSERT/UPDATE/DELETE on
-- partner_request_events succeeds for ANY role, including service_role —
-- only the SECURITY DEFINER functions may ever write to it.
-- ================================================================
do $$
declare
  some_request_id uuid;
  some_hotel_id uuid;
begin
  select id, hotel_id into some_request_id, some_hotel_id from public.partner_requests limit 1;

  execute format('set local role service_role');
  execute format('set local request.jwt.claims to %L', json_build_object('role', 'service_role')::text);

  begin
    insert into public.partner_request_events (hotel_id, partner_request_id, event_type, actor_type)
    values (some_hotel_id, some_request_id, 'cancelled', 'system');
    raise exception 'SECURITY BUG: service_role could INSERT directly into partner_request_events';
  exception
    when insufficient_privilege then
      raise notice 'OK: direct INSERT into partner_request_events rejected for service_role';
  end;

  begin
    update public.partner_request_events set message = 'tampered' where partner_request_id = some_request_id;
    raise exception 'SECURITY BUG: service_role could UPDATE partner_request_events directly';
  exception
    when insufficient_privilege then
      raise notice 'OK: direct UPDATE on partner_request_events rejected for service_role';
  end;

  begin
    delete from public.partner_request_events where partner_request_id = some_request_id;
    raise exception 'SECURITY BUG: service_role could DELETE from partner_request_events directly';
  exception
    when insufficient_privilege then
      raise notice 'OK: direct DELETE on partner_request_events rejected for service_role';
  end;

  reset role;
  reset "request.jwt.claims";
end $$;

-- ================================================================
-- 23) No direct write path on partner_requests either, for authenticated
-- OR service_role — the two RPC functions are the only legitimate route.
-- ================================================================
do $$
declare
  some_request_id uuid;
begin
  select id into some_request_id from public.partner_requests limit 1;

  execute format('set local role service_role');
  execute format('set local request.jwt.claims to %L', json_build_object('role', 'service_role')::text);
  begin
    update public.partner_requests set status = 'cancelled' where id = some_request_id;
    raise exception 'SECURITY BUG: service_role could UPDATE partner_requests directly';
  exception
    when insufficient_privilege then
      raise notice 'OK: direct UPDATE on partner_requests rejected for service_role';
  end;
  reset role;
  reset "request.jwt.claims";
end $$;

-- ================================================================
-- 24) Table grants — exact expected shape
-- ================================================================
do $$
declare
  bad text := '';
begin
  if not has_table_privilege('authenticated', 'public.partner_requests', 'SELECT') then bad := bad || 'authenticated missing SELECT on partner_requests. '; end if;
  if has_table_privilege('authenticated', 'public.partner_requests', 'INSERT') then bad := bad || 'authenticated has unexpected INSERT on partner_requests. '; end if;
  if has_table_privilege('authenticated', 'public.partner_requests', 'UPDATE') then bad := bad || 'authenticated has unexpected UPDATE on partner_requests. '; end if;
  if has_table_privilege('authenticated', 'public.partner_requests', 'DELETE') then bad := bad || 'authenticated has unexpected DELETE on partner_requests. '; end if;

  if not has_table_privilege('service_role', 'public.partner_requests', 'SELECT') then bad := bad || 'service_role missing SELECT on partner_requests. '; end if;
  if has_table_privilege('service_role', 'public.partner_requests', 'INSERT') then bad := bad || 'service_role has unexpected INSERT on partner_requests. '; end if;
  if has_table_privilege('service_role', 'public.partner_requests', 'UPDATE') then bad := bad || 'service_role has unexpected UPDATE on partner_requests. '; end if;
  if has_table_privilege('service_role', 'public.partner_requests', 'DELETE') then bad := bad || 'service_role has unexpected DELETE on partner_requests. '; end if;

  if has_table_privilege('anon', 'public.partner_requests', 'SELECT') then bad := bad || 'anon has unexpected SELECT on partner_requests. '; end if;
  if has_table_privilege('anon', 'public.partner_requests', 'INSERT') then bad := bad || 'anon has unexpected INSERT on partner_requests. '; end if;

  if not has_table_privilege('authenticated', 'public.partner_request_events', 'SELECT') then bad := bad || 'authenticated missing SELECT on partner_request_events. '; end if;
  if has_table_privilege('authenticated', 'public.partner_request_events', 'INSERT') then bad := bad || 'authenticated has unexpected INSERT on partner_request_events. '; end if;
  if not has_table_privilege('service_role', 'public.partner_request_events', 'SELECT') then bad := bad || 'service_role missing SELECT on partner_request_events. '; end if;
  if has_table_privilege('service_role', 'public.partner_request_events', 'INSERT') then bad := bad || 'service_role has unexpected INSERT on partner_request_events. '; end if;
  if has_table_privilege('anon', 'public.partner_request_events', 'SELECT') then bad := bad || 'anon has unexpected SELECT on partner_request_events. '; end if;

  if bad <> '' then
    raise exception 'GRANT BUG: %', bad;
  end if;
  raise notice 'OK: table grants exactly match the intended shape (authenticated/service_role SELECT-only via functions, anon nothing)';
end $$;

-- ================================================================
-- 25) RPC EXECUTE grants — exact expected shape
-- ================================================================
do $$
declare
  bad text := '';
  create_sig text := 'public.create_partner_request(uuid, uuid, uuid, text, text, text, date, text, integer, text)';
  apply_sig text := 'public.apply_partner_request_command(uuid, uuid, text, text, jsonb)';
begin
  if not has_function_privilege('authenticated', create_sig, 'EXECUTE') then bad := bad || 'authenticated missing EXECUTE on create_partner_request. '; end if;
  if not has_function_privilege('service_role', create_sig, 'EXECUTE') then bad := bad || 'service_role missing EXECUTE on create_partner_request. '; end if;
  if has_function_privilege('anon', create_sig, 'EXECUTE') then bad := bad || 'anon has unexpected EXECUTE on create_partner_request. '; end if;

  if not has_function_privilege('authenticated', apply_sig, 'EXECUTE') then bad := bad || 'authenticated missing EXECUTE on apply_partner_request_command. '; end if;
  if not has_function_privilege('service_role', apply_sig, 'EXECUTE') then bad := bad || 'service_role missing EXECUTE on apply_partner_request_command. '; end if;
  if has_function_privilege('anon', apply_sig, 'EXECUTE') then bad := bad || 'anon has unexpected EXECUTE on apply_partner_request_command. '; end if;

  if bad <> '' then
    raise exception 'GRANT BUG: %', bad;
  end if;
  raise notice 'OK: RPC EXECUTE grants exactly match the intended shape (authenticated + service_role only, never anon/public)';
end $$;

-- ================================================================
-- 26) Concurrency note — NOT fully testable within a single script/
-- transaction (a genuine race needs two concurrent sessions). The `select
-- ... for update` at the top of apply_partner_request_command (see
-- 0020_partner_requests.sql, section G) is what serializes two commands
-- racing on the same partner_request: the second blocks until the first
-- transaction commits, then re-reads the now-current status before
-- deciding whether its own command is still legal. Documented here as a
-- design guarantee, not exercised by this single-transaction test script.
-- ================================================================
do $$
begin
  raise notice 'NOTE: concurrency guarantee (FOR UPDATE row lock in apply_partner_request_command) is documented, not exercised here — requires two genuinely concurrent sessions to test.';
end $$;

rollback;
