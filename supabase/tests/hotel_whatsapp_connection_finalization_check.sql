-- Constraint/behavior checks for
-- 0025_hotel_whatsapp_connection_finalization.sql — run this in the
-- Supabase SQL editor (or psql connected to the project) AFTER 0024 AND
-- 0025 have both been applied.
--
-- BEGIN/ROLLBACK, same style as every other test script in this project —
-- everything this script writes is rolled back at the end. No real project
-- data is touched.
--
-- Uses the same `set local role ...` + catch `insufficient_privilege`
-- pattern already established in partner_requests_check.sql (section E/F
-- there) to behaviorally prove EXECUTE is denied at the grant level for
-- authenticated/anon — not just introspected via has_function_privilege()
-- (both are checked, for the same reason 0009's own
-- widget_service_role_permissions_check.sql checks both: introspection
-- proves the GRANT is correctly shaped, the real call proves Postgres
-- actually enforces it before the function body runs).

begin;

-- ================================================================
-- Fixtures.
-- ================================================================
do $$
declare
  hotel_a uuid;
  hotel_b uuid;
begin
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Finalization Test Hotel A', 'wa-finalization-test-hotel-a', 'ps_live_wa_final_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Finalization Test Hotel B', 'wa-finalization-test-hotel-b', 'ps_live_wa_final_test_b', 'active', true)
  returning id into hotel_b;

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%)', hotel_a, hotel_b;
end $$;

-- ================================================================
-- 1) authenticated CANNOT execute the RPC — behaviorally (insufficient_privilege)
-- AND via has_function_privilege() introspection.
-- ================================================================
do $$
declare
  hotel_a uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-finalization-test-hotel-a';

  if has_function_privilege('authenticated', 'public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text)', 'EXECUTE') then
    raise exception 'SECURITY BUG: authenticated has EXECUTE on finalize_hotel_whatsapp_connection';
  end if;

  execute format('set local role authenticated');
  begin
    perform public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-x', 'phone-x', null, 'cloud_api_only');
    raise exception 'SECURITY BUG: authenticated was able to call finalize_hotel_whatsapp_connection';
  exception
    when insufficient_privilege then
      raise notice 'OK: [1] authenticated rejected at the EXECUTE grant level (insufficient_privilege)';
  end;
  reset role;
end $$;

-- ================================================================
-- 2) anon CANNOT execute the RPC.
-- ================================================================
do $$
declare
  hotel_a uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-finalization-test-hotel-a';

  if has_function_privilege('anon', 'public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text)', 'EXECUTE') then
    raise exception 'SECURITY BUG: anon has EXECUTE on finalize_hotel_whatsapp_connection';
  end if;

  execute format('set local role anon');
  begin
    perform public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-x', 'phone-x', null, 'cloud_api_only');
    raise exception 'SECURITY BUG: anon was able to call finalize_hotel_whatsapp_connection';
  exception
    when insufficient_privilege then
      raise notice 'OK: [2] anon rejected at the EXECUTE grant level (insufficient_privilege)';
  end;
  reset role;
end $$;

-- ================================================================
-- 3) service_role CAN execute the RPC.
-- ================================================================
do $$
declare
  hotel_a uuid;
  v_id uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-finalization-test-hotel-a';

  if not has_function_privilege('service_role', 'public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text)', 'EXECUTE') then
    raise exception 'BUG: service_role is missing EXECUTE on finalize_hotel_whatsapp_connection';
  end if;

  execute format('set local role service_role');
  select id into v_id from public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-execute-probe', 'phone-execute-probe', null, 'cloud_api_only');
  reset role;

  if v_id is null then
    raise exception 'BUG: service_role call did not return a row';
  end if;
  -- Clean up this probe row via a raw delete (test-only superuser
  -- connection) so it never interferes with the primary-counting checks
  -- (16) further down.
  delete from public.hotel_whatsapp_connections where id = v_id;
  raise notice 'OK: [3] service_role can execute finalize_hotel_whatsapp_connection';
end $$;

-- ================================================================
-- 4/5/6/7/8) Core upsert/idempotence/primary lifecycle for hotel_a.
-- ================================================================
do $$
declare
  hotel_a uuid;
  conn_1_id uuid;
  conn_1_primary boolean;
  conn_1_connected_at timestamptz;
  conn_2_id uuid;
  conn_2_primary boolean;
  retry_id uuid;
  retry_connected_at timestamptz;
  retry_waba text;
  updated_waba text;
begin
  select id into hotel_a from public.hotels where slug = 'wa-finalization-test-hotel-a';

  -- ---- 4) first active number for this hotel becomes primary ----
  select id, is_primary, connected_at
  into conn_1_id, conn_1_primary, conn_1_connected_at
  from public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-1', 'phone-1', 'biz-1', 'coexistence');

  if conn_1_primary is not true then
    raise exception 'BUG: the first active connection for a hotel must become primary';
  end if;
  if conn_1_connected_at is null then
    raise exception 'BUG: connected_at must be set on first activation';
  end if;
  raise notice 'OK: [4] first active connection for hotel_a is primary, connected_at set';

  -- ---- 5) second active number for the SAME hotel becomes non-primary ----
  select id, is_primary into conn_2_id, conn_2_primary
  from public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-2', 'phone-2', null, 'cloud_api_only');

  if conn_2_primary is not false then
    raise exception 'BUG: a second active connection for a hotel that already has a primary must NOT become primary';
  end if;
  raise notice 'OK: [5] second active connection for hotel_a is non-primary, existing primary untouched';

  -- ---- 6) same phone_number_id + same hotel = idempotent (same row, no duplicate) ----
  select id into retry_id
  from public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-1', 'phone-1', 'biz-1', 'coexistence');

  if retry_id <> conn_1_id then
    raise exception 'BUG: idempotent re-finalization of the same phone_number_id created a DIFFERENT row (got %, expected %)', retry_id, conn_1_id;
  end if;
  if (select count(*) from public.hotel_whatsapp_connections where phone_number_id = 'phone-1') <> 1 then
    raise exception 'BUG: idempotent re-finalization produced a duplicate row for phone_number_id=phone-1';
  end if;
  raise notice 'OK: [6] same phone_number_id + same hotel is idempotent — no duplicate row created';

  -- ---- 7) retry preserves connected_at (never bumped to a new value) ----
  -- Force an obviously-different, hardcoded past value directly on the row
  -- (raw UPDATE via this script's own superuser connection) — same
  -- technique as hotel_whatsapp_connections_check.sql's own updated_at
  -- trigger test, and for the identical reason: now() is frozen for the
  -- WHOLE duration of this transaction, so a naive "was it changed by this
  -- call" comparison against the value observed at step 4 could not tell
  -- "preserved" apart from "recomputed to the same frozen now()".
  update public.hotel_whatsapp_connections set connected_at = '2000-01-01T00:00:00Z'::timestamptz where id = conn_1_id;

  select connected_at into retry_connected_at
  from public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-1', 'phone-1', 'biz-1', 'coexistence');

  if retry_connected_at <> '2000-01-01T00:00:00Z'::timestamptz then
    raise exception 'BUG: a retry on an already-connected row must preserve the existing connected_at, got %', retry_connected_at;
  end if;
  raise notice 'OK: [7] retry on an already-active connection preserves connected_at (coalesce, never bumped)';

  -- ---- 8) waba_id change for the SAME hotel + phone_number_id updates cleanly ----
  select id, waba_id into retry_id, updated_waba
  from public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-1-rotated', 'phone-1', 'biz-1', 'coexistence');

  if retry_id <> conn_1_id then
    raise exception 'BUG: a waba_id change for the same phone_number_id/hotel must update the SAME row, got a different id';
  end if;
  if updated_waba <> 'waba-1-rotated' then
    raise exception 'BUG: waba_id was not updated on the existing row (got %)', updated_waba;
  end if;
  raise notice 'OK: [8] waba_id change for the same hotel+phone_number_id updates the existing row cleanly';
end $$;

-- ================================================================
-- 9/10) Cross-tenant protection — POINT CRITIQUE.
-- ================================================================
do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  before_hotel_id uuid;
  before_waba text;
  before_status text;
  after_hotel_id uuid;
  after_waba text;
  after_status text;
begin
  select id into hotel_a from public.hotels where slug = 'wa-finalization-test-hotel-a';
  select id into hotel_b from public.hotels where slug = 'wa-finalization-test-hotel-b';

  select hotel_id, waba_id, status into before_hotel_id, before_waba, before_status
  from public.hotel_whatsapp_connections where phone_number_id = 'phone-1';

  begin
    perform public.finalize_hotel_whatsapp_connection(hotel_b, 'waba-stolen', 'phone-1', null, 'cloud_api_only');
    raise exception 'SECURITY BUG: hotel_b was allowed to claim phone-1, already linked to hotel_a';
  exception
    when others then
      if sqlerrm <> 'phone_number_cross_tenant' then
        raise exception 'BUG: expected phone_number_cross_tenant, got: %', sqlerrm;
      end if;
      raise notice 'OK: [9] phone_number_id already linked to another hotel raises phone_number_cross_tenant';
  end;

  -- ---- 10) hotel_a's row is untouched by the rejected attempt ----
  select hotel_id, waba_id, status into after_hotel_id, after_waba, after_status
  from public.hotel_whatsapp_connections where phone_number_id = 'phone-1';

  if after_hotel_id <> before_hotel_id or after_waba <> before_waba or after_status <> before_status then
    raise exception 'BUG: the rejected cross-tenant attempt mutated hotel_a''s existing row (hotel_id % -> %, waba_id % -> %, status % -> %)',
      before_hotel_id, after_hotel_id, before_waba, after_waba, before_status, after_status;
  end if;
  raise notice 'OK: [10] hotel_a''s row remains strictly intact after the rejected cross-tenant attempt';
end $$;

-- ================================================================
-- 11) business_id null is accepted.
-- ================================================================
do $$
declare
  hotel_b uuid;
  v_business_id text;
begin
  select id into hotel_b from public.hotels where slug = 'wa-finalization-test-hotel-b';

  select business_id into v_business_id
  from public.finalize_hotel_whatsapp_connection(hotel_b, 'waba-b1', 'phone-b1', null, 'cloud_api_only');

  if v_business_id is not null then
    raise exception 'BUG: expected business_id to be null';
  end if;
  raise notice 'OK: [11] business_id null accepted, no false requirement imposed';
end $$;

-- ================================================================
-- 12) invalid connection_type rejected.
-- ================================================================
do $$
declare
  hotel_a uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-finalization-test-hotel-a';
  begin
    perform public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-x', 'phone-invalid-type', null, 'not_a_real_type');
    raise exception 'BUG: an invalid connection_type value was accepted';
  exception
    when others then
      if sqlerrm <> 'invalid_connection_type' then
        raise exception 'BUG: expected invalid_connection_type, got: %', sqlerrm;
      end if;
      raise notice 'OK: [12] invalid connection_type rejected deterministically';
  end;
end $$;

-- ================================================================
-- 13) nonexistent hotel rejected.
-- ================================================================
do $$
begin
  begin
    perform public.finalize_hotel_whatsapp_connection('00000000-0000-0000-0000-000000000000', 'waba-x', 'phone-no-hotel', null, 'cloud_api_only');
    raise exception 'BUG: a connection was finalized for a non-existent hotel';
  exception
    when others then
      if sqlerrm <> 'hotel_not_found' then
        raise exception 'BUG: expected hotel_not_found, got: %', sqlerrm;
      end if;
      raise notice 'OK: [13] non-existent hotel rejected deterministically (hotel_not_found)';
  end;
end $$;

-- ================================================================
-- 14) no token/code/secret parameter anywhere in the function's own
-- catalog signature.
-- ================================================================
do $$
declare
  v_args text;
begin
  select pg_get_function_arguments(p.oid) into v_args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_hotel_whatsapp_connection';

  if v_args is null then
    raise exception 'BUG: finalize_hotel_whatsapp_connection not found in pg_proc';
  end if;
  if v_args ~* 'token|authorization_code|app_secret|access_token|credential' then
    raise exception 'SECURITY BUG: finalize_hotel_whatsapp_connection''s own signature references a secret-shaped parameter: %', v_args;
  end if;
  raise notice 'OK: [14] no token/code/secret parameter in finalize_hotel_whatsapp_connection''s own pg_proc signature (%)', v_args;
end $$;

-- ================================================================
-- 15) no direct INSERT/UPDATE/DELETE privilege was restored for ANY role —
-- 0025 adds exactly one RPC, nothing else, on top of 0024's own
-- fully-write-locked table.
-- ================================================================
do $$
declare
  leaked text := '';
begin
  if has_table_privilege('anon', 'public.hotel_whatsapp_connections', 'INSERT')
     or has_table_privilege('anon', 'public.hotel_whatsapp_connections', 'UPDATE')
     or has_table_privilege('anon', 'public.hotel_whatsapp_connections', 'DELETE') then
    leaked := leaked || 'anon ';
  end if;
  if has_table_privilege('authenticated', 'public.hotel_whatsapp_connections', 'INSERT')
     or has_table_privilege('authenticated', 'public.hotel_whatsapp_connections', 'UPDATE')
     or has_table_privilege('authenticated', 'public.hotel_whatsapp_connections', 'DELETE') then
    leaked := leaked || 'authenticated ';
  end if;
  if has_table_privilege('service_role', 'public.hotel_whatsapp_connections', 'INSERT')
     or has_table_privilege('service_role', 'public.hotel_whatsapp_connections', 'UPDATE')
     or has_table_privilege('service_role', 'public.hotel_whatsapp_connections', 'DELETE') then
    leaked := leaked || 'service_role ';
  end if;

  if leaked <> '' then
    raise exception 'SECURITY BUG: direct write privilege on hotel_whatsapp_connections was restored for: % — the RPC must remain the ONLY write path', leaked;
  end if;
  raise notice 'OK: [15] no direct INSERT/UPDATE/DELETE privilege exists for any role — finalize_hotel_whatsapp_connection remains the sole write path';
end $$;

-- ================================================================
-- 16) at most one active+primary connection per hotel, even after several
-- finalizations for the same hotel (4/5/8 above all targeted hotel_a).
-- ================================================================
do $$
declare
  hotel_a uuid;
  primary_count integer;
begin
  select id into hotel_a from public.hotels where slug = 'wa-finalization-test-hotel-a';
  select count(*) into primary_count
  from public.hotel_whatsapp_connections
  where hotel_id = hotel_a and status = 'active' and is_primary = true;

  if primary_count <> 1 then
    raise exception 'BUG: expected exactly 1 active+primary connection for hotel_a, found %', primary_count;
  end if;
  raise notice 'OK: [16] exactly one active+primary connection exists for hotel_a after multiple finalizations';
end $$;

-- ================================================================
-- Concurrency design (task section 15): a single-script BEGIN/ROLLBACK
-- test runs everything in ONE transaction/session and therefore CANNOT
-- reproduce two genuinely concurrent transactions racing on the same
-- hotel_id/phone_number_id — this script does not claim to. What IS
-- verified here, structurally, is that the row lock this concurrency
-- guarantee depends on is actually present in the deployed function body:
-- `select ... from public.hotels where id = p_hotel_id for update` (locks
-- the hotel row BEFORE the is_primary decision, serializing two
-- finalizations of the SAME hotel) and a second `for update` locking any
-- pre-existing row for the claimed phone_number_id (serializing a
-- same-number race). Two REAL concurrent sessions would need to be driven
-- from outside a single SQL script (e.g. two psql connections, or a
-- pgTAP/application-level test) to exercise the actual wait-then-reread
-- behavior — not attempted here, and not claimed to have been.
-- ================================================================
do $$
declare
  v_def text;
  v_lock_count integer;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_hotel_whatsapp_connection';

  select count(*) into v_lock_count from regexp_matches(v_def, 'for update', 'gi');
  if v_lock_count < 2 then
    raise exception 'BUG: expected at least 2 "for update" locks in finalize_hotel_whatsapp_connection (hotel row + phone_number_id row), found %', v_lock_count;
  end if;
  if v_def !~* 'from public\.hotels[\s\S]*?for update' then
    raise exception 'BUG: the hotel row lock (public.hotels ... for update) could not be found in the deployed function body';
  end if;

  raise notice 'OK: structural check — % "for update" row locks present in the deployed function body, including the hotels row lock this concurrency design depends on (real concurrent-transaction behavior not exercised by this single-script test — see comment above)', v_lock_count;
end $$;

rollback;
