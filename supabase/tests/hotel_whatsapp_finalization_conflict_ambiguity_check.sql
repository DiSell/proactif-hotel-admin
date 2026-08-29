-- Regression checks for
-- 0028_fix_whatsapp_finalization_conflict_target_ambiguity.sql — run this
-- in the Supabase SQL editor (or psql connected to the project) AFTER
-- 0024, 0025, 0026, 0027 AND 0028 have all been applied.
--
-- BEGIN/ROLLBACK, same style as every other test script in this project.
-- No real project data is touched.
--
-- SCOPE: this file targets ONLY the SECOND ambiguity bug (42702 on
-- `ON CONFLICT (phone_number_id)`) discovered by actually running
-- hotel_whatsapp_finalization_ambiguity_check.sql (0027's own test) after
-- 0027 was applied — that run is what surfaced this bug in the first
-- place, since 0027's test deliberately removed its own masking exception
-- handler so the native PostgreSQL error could propagate. This file does
-- not replace hotel_whatsapp_finalization_ambiguity_check.sql — once 0028
-- is applied, THAT file's own test [1] (the exact call that originally
-- surfaced this bug) must now pass end-to-end with no workaround.

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
  values ('WA Conflict Ambiguity Test Hotel A', 'wa-conflict-ambiguity-test-hotel-a', 'ps_live_wa_conflict_ambiguity_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Conflict Ambiguity Test Hotel B', 'wa-conflict-ambiguity-test-hotel-b', 'ps_live_wa_conflict_ambiguity_test_b', 'active', true)
  returning id into hotel_b;

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%)', hotel_a, hotel_b;
end $$;

-- ================================================================
-- 1) The exact previously-failing call now succeeds with no 42702 — left
-- WITHOUT an exception handler on purpose (same diagnostic discipline as
-- 0027's own test file): if this ever regresses, the native PostgreSQL
-- error must surface untouched, never masked by a generic message.
-- ================================================================
do $$
declare
  hotel_a uuid;
  conn_id uuid;
  conn_status text;
  conn_is_primary boolean;
begin
  select id into hotel_a from public.hotels where slug = 'wa-conflict-ambiguity-test-hotel-a';

  select f.id, f.status, f.is_primary
  into conn_id, conn_status, conn_is_primary
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-1'::text, 'conf-phone-1'::text, 'biz-1'::text, 'coexistence'::text,
    '\xAABBCCDDEE'::bytea, '\x000000000000000000000001'::bytea, '\x00000000000000000000000000000001'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  ) f;

  if conn_status <> 'active' or conn_is_primary is not true then
    raise exception 'BUG: [1] expected the first connection for hotel_a to be active+primary, got status=% is_primary=%', conn_status, conn_is_primary;
  end if;
  raise notice 'OK: [1] no 42702 raised via ON CONFLICT ON CONSTRAINT — first connection active + primary';
end $$;

-- ================================================================
-- 2) Idempotent retry on the SAME hotel + phone_number_id still upserts
-- the SAME row (proves the constraint-name arbiter behaves identically to
-- the previous column-list arbiter, not just that it avoids the error).
-- ================================================================
do $$
declare
  hotel_a uuid;
  original_conn_id uuid;
  original_connected_at timestamptz;
  retry_conn_id uuid;
  retry_connected_at timestamptz;
  retry_waba text;
begin
  select id into hotel_a from public.hotels where slug = 'wa-conflict-ambiguity-test-hotel-a';

  select id, connected_at into original_conn_id, original_connected_at
  from public.hotel_whatsapp_connections
  where hotel_id = hotel_a and phone_number_id = 'conf-phone-1';

  select f.id, f.connected_at, f.waba_id into retry_conn_id, retry_connected_at, retry_waba
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-1-rotated'::text, 'conf-phone-1'::text, 'biz-1'::text, 'coexistence'::text,
    '\xFFEEDD'::bytea, '\x000000000000000000000002'::bytea, '\x00000000000000000000000000000002'::bytea,
    'v2'::text, 1::smallint, null::timestamptz
  ) f;

  if retry_conn_id <> original_conn_id then
    raise exception 'BUG: [2] retry created a DIFFERENT connection_id (got %, expected %) — the constraint-name arbiter did not resolve to the same conflict row', retry_conn_id, original_conn_id;
  end if;
  if retry_connected_at <> original_connected_at then
    raise exception 'BUG: [2] connected_at was not preserved across the retry';
  end if;
  if retry_waba <> 'waba-1-rotated' then
    raise exception 'BUG: [2] waba_id was not updated by the ON CONFLICT DO UPDATE arm';
  end if;
  if (select count(*) from public.hotel_whatsapp_connections where phone_number_id = 'conf-phone-1') <> 1 then
    raise exception 'BUG: [2] a duplicate row was created instead of an upsert';
  end if;
  raise notice 'OK: [2] idempotent retry via the constraint-name arbiter upserts the same row, connected_at preserved, waba_id updated';
end $$;

-- ================================================================
-- 3) Cross-tenant is still rejected — the fix must not have loosened this.
-- ================================================================
do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  before_waba text;
begin
  select id into hotel_a from public.hotels where slug = 'wa-conflict-ambiguity-test-hotel-a';
  select id into hotel_b from public.hotels where slug = 'wa-conflict-ambiguity-test-hotel-b';

  select waba_id into before_waba from public.hotel_whatsapp_connections where phone_number_id = 'conf-phone-1';

  begin
    perform public.finalize_hotel_whatsapp_connection_with_secret(
      hotel_b::uuid, 'waba-stolen'::text, 'conf-phone-1'::text, null::text, 'cloud_api_only'::text,
      '\xAA'::bytea, '\x000000000000000000000003'::bytea, '\x00000000000000000000000000000003'::bytea,
      'v1'::text, 1::smallint, null::timestamptz
    );
    raise exception 'SECURITY BUG: [3] hotel_b was allowed to claim conf-phone-1, already linked to hotel_a';
  exception
    when others then
      if sqlerrm <> 'phone_number_cross_tenant' then
        raise exception 'BUG: [3] expected phone_number_cross_tenant, got: %', sqlerrm;
      end if;
      raise notice 'OK: [3] cross-tenant attempt still rejected (phone_number_cross_tenant)';
  end;

  if (select waba_id from public.hotel_whatsapp_connections where phone_number_id = 'conf-phone-1') <> before_waba then
    raise exception 'BUG: [3] hotel_a''s connection was mutated by the rejected cross-tenant attempt';
  end if;
  raise notice 'OK: [3] hotel_a''s connection remains intact after the rejected cross-tenant attempt';
end $$;

-- ================================================================
-- 4) service_role still cannot call finalize_hotel_whatsapp_connection()
-- directly; the 0026 composite RPC remains callable by service_role.
-- ================================================================
do $$
declare
  hotel_a uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-conflict-ambiguity-test-hotel-a';

  if has_function_privilege('service_role', 'public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text)', 'EXECUTE') then
    raise exception 'SECURITY BUG: [4] service_role has EXECUTE on finalize_hotel_whatsapp_connection after 0028';
  end if;

  execute format('set local role service_role');
  begin
    perform public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-direct-probe', 'conf-phone-direct-probe', null, 'cloud_api_only');
    raise exception 'SECURITY BUG: [4] service_role was able to call finalize_hotel_whatsapp_connection directly after 0028';
  exception
    when insufficient_privilege then
      raise notice 'OK: [4] service_role still rejected at the EXECUTE grant level when calling finalize_hotel_whatsapp_connection directly';
  end;
  reset role;

  execute format('set local role service_role');
  perform public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-composite-probe'::text, 'conf-phone-composite-probe'::text, null::text, 'cloud_api_only'::text,
    '\xAA'::bytea, '\x000000000000000000000004'::bytea, '\x00000000000000000000000000000004'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  );
  reset role;
  raise notice 'OK: [4] the 0026 composite RPC remains callable by service_role after 0028';
end $$;

-- ================================================================
-- 5) Structural check on the ACTUAL deployed function definition: the
-- bare, ambiguous `on conflict (phone_number_id)` form must be gone, and
-- the constraint-name form must be present.
-- ================================================================
do $$
declare
  v_def text;
  v_normalized text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_hotel_whatsapp_connection';

  if v_def is null then
    raise exception 'BUG: [5] finalize_hotel_whatsapp_connection not found';
  end if;

  -- Plain, whitespace-normalized SUBSTRING search (position()), not a
  -- hand-rolled regex. TWO prior versions of this check both produced a
  -- FALSE POSITIVE:
  --   1. `~* 'on conflict\s*\(\s*phone_number_id\s*\)'` — assumed to be an
  --      ARE-quoting subtlety, replaced with plain position().
  --   2. The plain position() version STILL matched — because
  --      pg_get_functiondef() returns the function's COMPLETE literal
  --      source TEXT, including its own `--` comments, and 0028's own
  --      migration deliberately documents the fix by quoting the OLD,
  --      now-fixed form in prose: "...instead of by the bare column list
  --      `on conflict (phone_number_id)` —". That comment line is itself
  --      part of v_def, so an unfiltered substring search matches the
  --      DOCUMENTATION, not the code — the exact same class of mistake
  --      already hit (and fixed) repeatedly at the TypeScript level
  --      earlier in this project (a check banning a phrase matching that
  --      same phrase quoted in a comment explaining why it's banned).
  -- Fixed by stripping `--` line comments BEFORE collapsing whitespace and
  -- searching — only the real, executable SQL is left to match against.
  v_normalized := regexp_replace(regexp_replace(lower(v_def), '--[^\n]*', '', 'g'), '\s+', ' ', 'g');

  if position('on conflict (phone_number_id)' in v_normalized) > 0 then
    raise exception 'BUG: [5] the deployed function still uses the ambiguous bare `on conflict (phone_number_id)` form: %', v_def;
  end if;
  if position('on conflict on constraint hotel_whatsapp_connections_phone_number_id_key' in v_normalized) = 0 then
    raise exception 'BUG: [5] the expected `on conflict on constraint hotel_whatsapp_connections_phone_number_id_key` form was not found in the deployed function body: %', v_def;
  end if;
  raise notice 'OK: [5] the deployed function uses the constraint-name arbiter, never the ambiguous bare column-list form';
end $$;

rollback;
