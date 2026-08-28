-- Constraint/behavior checks for
-- 0023_partner_request_deliveries.sql — run this in the Supabase SQL
-- editor (or psql connected to the project) AFTER that migration has been
-- applied (which itself requires 0020/0021/0022 already applied).
--
-- BEGIN/ROLLBACK, same style as every other test script in this project —
-- everything this script writes is rolled back at the end. No real
-- project data is touched.
--
-- SECURITY BOUNDARY: 0023 deliberately revokes INSERT/UPDATE/DELETE on
-- partner_request_deliveries from EVERY role, including service_role —
-- the three SECURITY DEFINER RPCs (create_partner_request_delivery /
-- start_partner_request_delivery / complete_partner_request_delivery) are
-- the ONLY write path, by design (same discipline as partner_requests
-- itself, 0020_partner_requests.sql). This script respects that boundary
-- exactly as production code must: every write below goes through one of
-- the three RPCs, never a direct INSERT/UPDATE/DELETE on the table. Where
-- the RPCs make a constraint violation structurally UNREACHABLE from the
-- API (the `status` column — see section 2 below), this script verifies
-- the constraint's real definition via pg_constraint/pg_get_constraintdef
-- instead of bypassing permissions to force a violation.
--
-- Scoped strictly to what 0023 itself adds: the deliveries table's own
-- constraints/RPCs/grants, and the new partner_delivery_ambiguous
-- command's effect (or rather non-effect) on partner_requests.status.
-- Caller authorization, the pre-existing command vocabulary, and the
-- append-only event log are already exhaustively covered by
-- partner_requests_check.sql and
-- partner_requests_active_idempotency_check.sql and are NOT repeated here.

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  partner_a uuid;
  partner_b uuid;
  conversation_a uuid;
  conversation_a2 uuid;
  conversation_b uuid;
  conversation_c uuid; -- dedicated to the reply-token-hash-uniqueness section, kept independent from every other section's fixtures
  request_a uuid; -- used for the concurrency / alternative_acceptance-independence / FK+purpose-CHECK-via-RPC sections
  request_a2 uuid; -- used for the provider_message_id-uniqueness / failed-permits-retry / partner_delivery_ambiguous sections
  request_b uuid; -- used for the unknown/no-auto-retry section
  request_c uuid; -- used for the reply-token-hash-uniqueness section
  delivery_1 uuid;
  delivery_2 uuid;
  delivery_c1 uuid;
  delivery_c2 uuid;
  delivery_unknown uuid;
  status_check text;
  request_status_check text;
  count_check integer;
  resolved_request_id uuid;
  v_constraint_def text;
  v_role text;
  v_priv text;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Deliveries Test Hotel A', 'deliveries-test-hotel-a', 'ps_live_deliveries_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Deliveries Test Hotel B', 'deliveries-test-hotel-b', 'ps_live_deliveries_test_b', 'active', true)
  returning id into hotel_b;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_a, 'Restaurant Deliveries A', 'restaurant', true, 'accepted')
  returning id into partner_a;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status)
  values (hotel_b, 'Restaurant Deliveries B', 'restaurant', true, 'accepted')
  returning id into partner_b;

  -- request_a / request_a2 / request_c are treated as fully INDEPENDENT
  -- partner_requests throughout this script — each needs its OWN
  -- conversation (0021's partner_requests_hotel_conversation_active_key
  -- allows at most one ACTIVE partner_request per (hotel_id,
  -- conversation_id), and create_partner_request() always inserts as
  -- 'draft', an active status).
  insert into public.conversations (hotel_id, session_id)
  values (hotel_a, 'deliveries-test-session-a')
  returning id into conversation_a;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_a, 'deliveries-test-session-a2')
  returning id into conversation_a2;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_a, 'deliveries-test-session-c')
  returning id into conversation_c;

  insert into public.conversations (hotel_id, session_id)
  values (hotel_b, 'deliveries-test-session-b')
  returning id into conversation_b;

  execute format('set local role service_role');
  execute format('set local request.jwt.claims to %L', json_build_object('role', 'service_role')::text);

  request_a := public.create_partner_request(
    hotel_a, partner_a, conversation_a, 'Guest A', '+33611111111', 'restaurant', current_date + 1, '20:00', 2, null
  );
  request_a2 := public.create_partner_request(
    hotel_a, partner_a, conversation_a2, 'Guest A2', '+33611111112', 'restaurant', current_date + 1, '20:00', 2, null
  );
  request_c := public.create_partner_request(
    hotel_a, partner_a, conversation_c, 'Guest C', '+33611111113', 'restaurant', current_date + 1, '20:00', 2, null
  );
  request_b := public.create_partner_request(
    hotel_b, partner_b, conversation_b, 'Guest B', '+33622222222', 'restaurant', current_date + 1, '20:00', 2, null
  );

  raise notice 'OK: fixtures created';

  -- ================================================================
  -- 1) FK composite tenant-safe.
  --
  -- 1a) Application-level defense: create_partner_request_delivery()'s own
  -- existence check (scoped by BOTH id and hotel_id) rejects a
  -- cross-tenant pair BEFORE any INSERT is attempted — this is a defense
  -- in addition to, not a substitute for, the schema-level FK below.
  -- ================================================================
  begin
    perform public.create_partner_request_delivery(hotel_b, request_a, 'meta', 'initial_request');
    raise exception 'BUG: a delivery was created for a partner_request belonging to a different hotel';
  exception
    when sqlstate 'P0002' then
      raise notice 'OK: create_partner_request_delivery rejects a cross-tenant (hotel_id, partner_request_id) pair (application-level)';
  end;

  -- 1b) Schema-level guarantee, verified via the catalog rather than by
  -- bypassing the RPC — the FK itself makes a cross-tenant row impossible
  -- even if application code had a bug, independent of the check above.
  select pg_get_constraintdef(oid) into v_constraint_def
  from pg_constraint
  where conrelid = 'public.partner_request_deliveries'::regclass
    and contype = 'f'
    and conname = 'partner_request_deliveries_request_fk';
  if v_constraint_def is null then
    raise exception 'BUG: partner_request_deliveries_request_fk not found';
  end if;
  if v_constraint_def !~ 'partner_request_id'
     or v_constraint_def !~ 'hotel_id'
     or v_constraint_def !~ 'partner_requests' then
    raise exception 'BUG: partner_request_deliveries_request_fk does not reference the expected columns/table: %', v_constraint_def;
  end if;
  raise notice 'OK: partner_request_deliveries_request_fk is a real composite FK to partner_requests(id, hotel_id) — % ', v_constraint_def;

  -- ================================================================
  -- 2) status CHECK constraint.
  --
  -- NOT tested via a direct INSERT (service_role itself has no INSERT
  -- privilege on this table — 0023's own security boundary) and NOT
  -- reachable via the RPCs either: create_partner_request_delivery()
  -- always inserts the literal 'queued', start_partner_request_delivery()
  -- always sets the literal 'sending', and
  -- complete_partner_request_delivery() validates p_outcome against a
  -- closed list ('sent'/'failed'/'unknown') BEFORE ever reaching the
  -- UPDATE — an invalid status is therefore structurally unreachable from
  -- the API surface, which is itself a property worth confirming, not a
  -- gap. Verified instead via the constraint's own real definition,
  -- including an exact cardinality check so a silent vocabulary drift
  -- (an added/removed value without updating this test) is caught.
  -- ================================================================
  select pg_get_constraintdef(oid) into v_constraint_def
  from pg_constraint
  where conrelid = 'public.partner_request_deliveries'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like 'CHECK ((status =%';
  if v_constraint_def is null then
    raise exception 'BUG: no CHECK constraint found on partner_request_deliveries.status';
  end if;
  if v_constraint_def !~ '''queued'''
     or v_constraint_def !~ '''sending'''
     or v_constraint_def !~ '''sent'''
     or v_constraint_def !~ '''failed'''
     or v_constraint_def !~ '''unknown''' then
    raise exception 'BUG: status CHECK constraint is missing an expected value: %', v_constraint_def;
  end if;
  if (length(v_constraint_def) - length(replace(v_constraint_def, '::text', ''))) / length('::text') <> 5 then
    raise exception 'BUG: status CHECK constraint vocabulary drifted (expected exactly 5 values): %', v_constraint_def;
  end if;
  raise notice 'OK: status CHECK constraint enumerates exactly queued/sending/sent/failed/unknown — %', v_constraint_def;

  -- ================================================================
  -- 3) purpose CHECK constraint.
  --
  -- UNLIKE status, purpose IS reachable via the API:
  -- create_partner_request_delivery() passes its p_purpose argument
  -- straight into the INSERT, so a real end-to-end violation can be
  -- triggered through the RPC itself — no direct INSERT needed.
  -- ================================================================
  begin
    perform public.create_partner_request_delivery(hotel_a, request_a, 'meta', 'not_a_real_purpose');
    raise exception 'BUG: an invalid purpose value was accepted';
  exception
    when check_violation then
      raise notice 'OK: purpose CHECK constraint rejects an unknown value, triggered through create_partner_request_delivery() itself';
  end;

  select pg_get_constraintdef(oid) into v_constraint_def
  from pg_constraint
  where conrelid = 'public.partner_request_deliveries'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like 'CHECK ((purpose =%';
  if v_constraint_def is null then
    raise exception 'BUG: no CHECK constraint found on partner_request_deliveries.purpose';
  end if;
  if v_constraint_def !~ '''initial_request''' or v_constraint_def !~ '''alternative_acceptance''' then
    raise exception 'BUG: purpose CHECK constraint is missing an expected value: %', v_constraint_def;
  end if;
  if (length(v_constraint_def) - length(replace(v_constraint_def, '::text', ''))) / length('::text') <> 2 then
    raise exception 'BUG: purpose CHECK constraint vocabulary drifted (expected exactly 2 values): %', v_constraint_def;
  end if;
  raise notice 'OK: purpose CHECK constraint enumerates exactly initial_request/alternative_acceptance — %', v_constraint_def;

  -- ================================================================
  -- 4) Two concurrent ACTIVE deliveries for the SAME (hotel, request,
  -- purpose) are forbidden — the core concurrency guard. All via RPC.
  -- ================================================================
  delivery_1 := public.create_partner_request_delivery(hotel_a, request_a, 'meta', 'initial_request');

  begin
    perform public.create_partner_request_delivery(hotel_a, request_a, 'meta', 'initial_request');
    raise exception 'BUG: a second ACTIVE delivery for the same request+purpose was created';
  exception
    when sqlstate '23505' then
      raise notice 'OK: a concurrent second active delivery for the same request+purpose is rejected with 23505';
  end;

  -- ================================================================
  -- 5) provider_message_id unique across the whole table — created via
  -- create_partner_request_delivery, advanced via start/complete, never a
  -- direct write.
  -- ================================================================
  delivery_2 := public.create_partner_request_delivery(hotel_a, request_a2, 'meta', 'initial_request');
  perform public.start_partner_request_delivery(delivery_1, hotel_a, 'hash-accept-1', 'hash-reject-1', 'hash-alt-1');
  perform public.complete_partner_request_delivery(delivery_1, hotel_a, 'sent', 'wamid.shared-id', null);

  perform public.start_partner_request_delivery(delivery_2, hotel_a, 'hash-accept-2', 'hash-reject-2', 'hash-alt-2');
  begin
    perform public.complete_partner_request_delivery(delivery_2, hotel_a, 'sent', 'wamid.shared-id', null);
    raise exception 'BUG: two deliveries were allowed to share the same provider_message_id';
  exception
    when unique_violation then
      raise notice 'OK: provider_message_id uniqueness enforced across the whole table';
  end;

  -- delivery_2 is still 'sending' after the failed complete() attempt
  -- above (that specific statement rolled back, not the whole delivery) —
  -- resolve it cleanly via the RPC so it doesn't interfere with section 7.
  perform public.complete_partner_request_delivery(delivery_2, hotel_a, 'failed', null, 'provider_error');

  -- ================================================================
  -- 6) Reply token hashes unique across the whole table (each of the
  -- three columns independently) — exercised via
  -- start_partner_request_delivery on two INDEPENDENT, dedicated
  -- deliveries (request_c), never a direct UPDATE.
  -- ================================================================
  delivery_c1 := public.create_partner_request_delivery(hotel_a, request_c, 'meta', 'initial_request');
  perform public.start_partner_request_delivery(delivery_c1, hotel_a, 'hash-accept-c1', 'hash-reject-c1', 'hash-alt-c1');

  -- A different purpose for the SAME request — deliberately independent
  -- of delivery_c1's own active-purpose slot (see section 8's own
  -- independence guarantee), used purely as a second delivery row to
  -- attempt a colliding start() against.
  delivery_c2 := public.create_partner_request_delivery(hotel_a, request_c, 'meta', 'alternative_acceptance');

  begin
    perform public.start_partner_request_delivery(delivery_c2, hotel_a, 'hash-accept-c1', 'hash-reject-c2a', 'hash-alt-c2a');
    raise exception 'BUG: two deliveries were allowed to share the same accept_reply_token_hash';
  exception
    when unique_violation then
      raise notice 'OK: accept_reply_token_hash uniqueness enforced';
  end;

  begin
    perform public.start_partner_request_delivery(delivery_c2, hotel_a, 'hash-accept-c2b', 'hash-reject-c1', 'hash-alt-c2b');
    raise exception 'BUG: two deliveries were allowed to share the same reject_reply_token_hash';
  exception
    when unique_violation then
      raise notice 'OK: reject_reply_token_hash uniqueness enforced';
  end;

  begin
    perform public.start_partner_request_delivery(delivery_c2, hotel_a, 'hash-accept-c2c', 'hash-reject-c2c', 'hash-alt-c1');
    raise exception 'BUG: two deliveries were allowed to share the same propose_alternative_token_hash';
  exception
    when unique_violation then
      raise notice 'OK: propose_alternative_token_hash uniqueness enforced';
  end;

  -- delivery_c2 is still 'queued' (every attempt above rolled back to its
  -- own savepoint without touching it) — confirm it can still be started
  -- normally with genuinely fresh hashes, proving the rejections above
  -- were specific to the collision, not a side effect that broke the row.
  perform public.start_partner_request_delivery(delivery_c2, hotel_a, 'hash-accept-c2-final', 'hash-reject-c2-final', 'hash-alt-c2-final');
  raise notice 'OK: the same delivery can still be started normally once given genuinely unique hashes';

  -- ================================================================
  -- 7) A `failed` delivery never blocks a new, explicit attempt of the
  -- SAME purpose for the SAME request.
  -- ================================================================
  perform public.create_partner_request_delivery(hotel_a, request_a2, 'meta', 'initial_request');
  raise notice 'OK: a failed delivery never blocks a new attempt of the same purpose';

  -- ================================================================
  -- 8) initial_request and alternative_acceptance are fully independent —
  -- request_a's initial_request delivery is currently `sent` (from
  -- section 5), yet an alternative_acceptance delivery for the SAME
  -- request must still be creatable.
  -- ================================================================
  perform public.create_partner_request_delivery(hotel_a, request_a, 'meta', 'alternative_acceptance');
  raise notice 'OK: alternative_acceptance is never blocked by an already-sent initial_request for the same partner_request';

  -- ================================================================
  -- 9) unknown is conserved, blocks a new attempt of the same purpose, and
  -- is NEVER auto-converted to failed.
  -- ================================================================
  delivery_unknown := public.create_partner_request_delivery(hotel_b, request_b, 'meta', 'initial_request');
  perform public.start_partner_request_delivery(delivery_unknown, hotel_b, 'hash-accept-unknown', 'hash-reject-unknown', 'hash-alt-unknown');
  perform public.complete_partner_request_delivery(delivery_unknown, hotel_b, 'unknown', null, 'provider_unknown');

  select status into status_check from public.partner_request_deliveries where id = delivery_unknown;
  if status_check <> 'unknown' then
    raise exception 'BUG: expected delivery to remain unknown, found %', status_check;
  end if;
  raise notice 'OK: an unknown delivery is conserved as-is, never silently resolved';

  begin
    perform public.create_partner_request_delivery(hotel_b, request_b, 'meta', 'initial_request');
    raise exception 'BUG: a new attempt was allowed while a previous one for the same purpose is still unknown';
  exception
    when sqlstate '23505' then
      raise notice 'OK: unknown blocks a new attempt of the same purpose at the SCHEMA level — no automatic retry possible even by a buggy caller';
  end;

  -- ================================================================
  -- 10) partner_delivery_ambiguous never alters partner_requests.status,
  -- and produces exactly the expected audit event. Goes through
  -- apply_partner_request_command() — no partner_request_deliveries
  -- write involved in this section at all.
  -- ================================================================
  perform public.apply_partner_request_command(request_a2, hotel_a, 'request_guest_confirmation');
  select status into request_status_check from public.partner_requests where id = request_a2;
  if request_status_check <> 'pending_confirmation' then
    raise exception 'BUG: fixture setup wrong — expected request_a2 at pending_confirmation, found %', request_status_check;
  end if;

  perform public.apply_partner_request_command(request_a2, hotel_a, 'partner_delivery_ambiguous');

  select status into request_status_check from public.partner_requests where id = request_a2;
  if request_status_check <> 'pending_confirmation' then
    raise exception 'BUG: partner_delivery_ambiguous altered partner_requests.status, found %', request_status_check;
  end if;
  raise notice 'OK: partner_delivery_ambiguous never changes partner_requests.status';

  select count(*) into count_check
  from public.partner_request_events
  where partner_request_id = request_a2 and event_type = 'partner_delivery_ambiguous' and actor_type = 'system';
  if count_check <> 1 then
    raise exception 'BUG: expected exactly 1 partner_delivery_ambiguous event, found %', count_check;
  end if;
  raise notice 'OK: partner_delivery_ambiguous produces exactly the expected system-actor audit event';

  -- ================================================================
  -- 11) A reply token hash can only ever resolve to the ONE delivery
  -- (and therefore the ONE partner_request) it actually belongs to.
  -- Read-only (SELECT is, correctly, granted to service_role) — no
  -- permission concern here.
  -- ================================================================
  select partner_request_id into resolved_request_id
  from public.partner_request_deliveries
  where accept_reply_token_hash = 'hash-accept-c1';
  if resolved_request_id <> request_c then
    raise exception 'BUG: accept_reply_token_hash resolved to the wrong partner_request';
  end if;
  if resolved_request_id = request_a2 then
    raise exception 'BUG: a token hash resolved to a foreign partner_request';
  end if;
  raise notice 'OK: a reply token hash resolves to exactly the delivery (and partner_request) it was issued for, never another';

  -- ================================================================
  -- 12) Direct-write permissions remain revoked for EVERY role — the
  -- exact security boundary this whole script now respects rather than
  -- bypasses. anon/authenticated never had any grant on this table at all
  -- (0023's own "no policy at all" design); service_role explicitly has
  -- SELECT but INSERT/UPDATE/DELETE explicitly revoked. has_table_privilege()
  -- is role-membership-aware and independent of RLS (RLS governs which
  -- ROWS are visible/writable, not WHETHER a role holds the privilege at
  -- all — service_role bypasses RLS entirely in this project's Supabase
  -- setup, which is exactly why the GRANT-level revoke, verified here, is
  -- the real boundary for that role, not a policy).
  -- ================================================================
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(v_role, 'public.partner_request_deliveries', v_priv) then
        raise exception 'BUG: role % unexpectedly has % on partner_request_deliveries — the RPCs would no longer be the only write path', v_role, v_priv;
      end if;
    end loop;
  end loop;
  if not has_table_privilege('service_role', 'public.partner_request_deliveries', 'SELECT') then
    raise exception 'BUG: service_role is missing its own intended SELECT grant on partner_request_deliveries';
  end if;
  raise notice 'OK: anon/authenticated/service_role all lack direct INSERT/UPDATE/DELETE on partner_request_deliveries — the three RPCs remain the only write path, and service_role''s own SELECT grant is exactly as intended';

  -- ================================================================
  -- 13) No automatic deletion/merge anywhere in this flow.
  -- ================================================================
  -- delivery_1 (request_a/initial_request/sent), delivery_2
  -- (request_a2/initial_request/failed), delivery_c1
  -- (request_c/initial_request/sending), delivery_c2
  -- (request_c/alternative_acceptance/sending), the retry created in
  -- section 7 (request_a2/initial_request/queued), the
  -- alternative_acceptance delivery from section 8 (request_a/queued),
  -- and delivery_unknown (request_b/initial_request/unknown) — every
  -- rejected attempt above left no row behind.
  select count(*) into count_check from public.partner_request_deliveries where hotel_id in (hotel_a, hotel_b);
  if count_check <> 7 then
    raise exception 'BUG: expected exactly 7 partner_request_deliveries rows total, found %', count_check;
  end if;
  raise notice 'OK: no delivery row was ever automatically deleted or merged';

  raise notice 'OK: all partner_request_deliveries checks passed';
end $$;

rollback;
