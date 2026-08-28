-- Constraint/behavior checks for
-- 0021_partner_requests_active_idempotency.sql — run this in the Supabase
-- SQL editor (or psql connected to the project) AFTER that migration has
-- been applied (which itself requires 0020_partner_requests.sql already
-- applied).
--
-- BEGIN/ROLLBACK, same style as partner_requests_check.sql — everything
-- this script writes is rolled back at the end. No real project data is
-- touched.
--
-- Scoped strictly to the NEW uniqueness guarantee added by 0021 — caller
-- authorization (service_role/superadmin/hotel_admin/anon), the state
-- machine's own transition rules, and the append-only event log are already
-- exhaustively covered by partner_requests_check.sql and are NOT repeated
-- here. Every create_partner_request() call below runs as service_role
-- (the chatbot's own trust boundary) to keep this file focused on the
-- index's behavior alone.

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  partner_a uuid;
  partner_b uuid;
  conversation_a1 uuid; -- hotel_a, first conversation
  conversation_a2 uuid; -- hotel_a, second, independent conversation
  conversation_b uuid;  -- hotel_b
  request_1 uuid;
  request_2 uuid;
  request_3 uuid;
  status_check text;
  active_count integer;
  total_rows_after integer;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('PR Idempotency Test Hotel A', 'pr-idem-test-hotel-a', 'ps_live_pr_idem_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('PR Idempotency Test Hotel B', 'pr-idem-test-hotel-b', 'ps_live_pr_idem_test_b', 'active', true)
  returning id into hotel_b;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_a, 'Restaurant Idem A', 'restaurant', true, 'accepted')
  returning id into partner_a;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_b, 'Restaurant Idem B', 'restaurant', true, 'accepted')
  returning id into partner_b;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_a, 'pr-idem-test-session-a1')
  returning id into conversation_a1;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_a, 'pr-idem-test-session-a2')
  returning id into conversation_a2;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_b, 'pr-idem-test-session-b')
  returning id into conversation_b;

  raise notice 'OK: fixtures created';

  execute format('set local role service_role');
  execute format('set local request.jwt.claims to %L', json_build_object('role', 'service_role')::text);

  -- ================================================================
  -- 1) One active request for a conversation -> OK
  -- ================================================================
  request_1 := public.create_partner_request(
    hotel_a, partner_a, conversation_a1, 'Guest One', '+33611111111',
    'restaurant', current_date + 1, '20:00', 2, null
  );

  select count(*) into active_count
  from public.partner_requests
  where hotel_id = hotel_a and conversation_id = conversation_a1
    and status in ('draft', 'pending_confirmation', 'sent_to_partner', 'alternative_proposed');
  if active_count <> 1 then
    raise exception 'BUG: expected exactly 1 active request for conversation_a1, found %', active_count;
  end if;
  raise notice 'OK: a single active request is created normally';

  -- ================================================================
  -- 2) Second create for the SAME hotel_id + conversation_id, while the
  -- first is still active (status = draft) -> must fail with 23505, the
  -- exact SQLSTATE the chatbot layer (chatbotService.ts) is written to
  -- catch and recover from.
  -- ================================================================
  begin
    perform public.create_partner_request(
      hotel_a, partner_a, conversation_a1, 'Guest Two', '+33622222222',
      'restaurant', current_date + 1, '20:30', 4, null
    );
    raise exception 'BUG: a second active partner_request was created for the same conversation';
  exception
    when sqlstate '23505' then
      raise notice 'OK: second concurrent-style create for the same active conversation rejected with 23505';
  end;

  -- No new row must exist from the failed attempt above (a failed INSERT
  -- inside its own exception-caught sub-block still rolls back cleanly —
  -- confirmed explicitly here, not just assumed).
  select count(*) into active_count
  from public.partner_requests
  where hotel_id = hotel_a and conversation_id = conversation_a1;
  if active_count <> 1 then
    raise exception 'BUG: expected exactly 1 total row for conversation_a1 after the rejected duplicate attempt, found %', active_count;
  end if;
  raise notice 'OK: the rejected duplicate attempt left no partial row behind';

  -- ================================================================
  -- 3) Advance request_1 to a terminal status (cancelled) — a terminal
  -- request must no longer count toward the uniqueness guarantee, so a NEW
  -- active request for the SAME conversation becomes possible again.
  -- ================================================================
  perform public.apply_partner_request_command(request_1, hotel_a, 'request_guest_confirmation');
  perform public.apply_partner_request_command(request_1, hotel_a, 'cancel_by_guest');

  select status into status_check from public.partner_requests where id = request_1;
  if status_check <> 'cancelled' then
    raise exception 'BUG: expected request_1 to be cancelled, found %', status_check;
  end if;

  request_2 := public.create_partner_request(
    hotel_a, partner_a, conversation_a1, 'Guest Three', '+33633333333',
    'restaurant', current_date + 2, '19:00', 2, null
  );
  raise notice 'OK: a terminal (cancelled) request never blocks a new active request for the same conversation';

  -- ================================================================
  -- 4) A different conversation for the SAME hotel is entirely independent
  -- — creating an active request there while conversation_a1 already has
  -- one (request_2, still draft) must succeed.
  -- ================================================================
  request_3 := public.create_partner_request(
    hotel_a, partner_a, conversation_a2, 'Guest Four', '+33644444444',
    'restaurant', current_date + 1, '20:00', 2, null
  );
  raise notice 'OK: a different conversation for the same hotel is unaffected by conversation_a1''s active request';

  -- ================================================================
  -- 5) A different hotel is entirely independent too.
  -- ================================================================
  perform public.create_partner_request(
    hotel_b, partner_b, conversation_b, 'Guest Five', '+33655555555',
    'restaurant', current_date + 1, '20:00', 2, null
  );
  raise notice 'OK: a different hotel is unaffected by hotel_a''s active requests';

  -- ================================================================
  -- 6) No automatic deletion/merge anywhere in this flow — every row this
  -- script created is still present (request_1 cancelled-but-present,
  -- request_2, request_3, plus hotel_b's) exactly once each.
  -- ================================================================
  select count(*) into total_rows_after
  from public.partner_requests
  where hotel_id in (hotel_a, hotel_b);
  if total_rows_after <> 4 then
    raise exception 'BUG: expected exactly 4 partner_requests rows total (1 cancelled + 3 active across conversations/hotels), found %', total_rows_after;
  end if;
  raise notice 'OK: no row was ever automatically deleted or merged — exactly the rows this script created remain';

  raise notice 'OK: all partner_requests active-idempotency checks passed';
end $$;

rollback;
