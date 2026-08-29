-- Regression checks for 0027_fix_whatsapp_finalization_ambiguities.sql —
-- run this in the Supabase SQL editor (or psql connected to the project)
-- AFTER 0024, 0025, 0026 AND 0027 have all been applied.
--
-- BEGIN/ROLLBACK, same style as every other test script in this project.
-- No real project data is touched.
--
-- SCOPE: this file targets ONLY the column-ambiguity bug (Postgres 42702)
-- found in the deployed finalize_hotel_whatsapp_connection() and its fix in
-- 0027 — it re-exercises the same business behaviors already covered by
-- hotel_whatsapp_connection_finalization_check.sql (0025) and
-- hotel_whatsapp_connection_secrets_check.sql (0026) specifically THROUGH
-- the previously-broken call path (finalize_hotel_whatsapp_connection_with_secret
-- -> finalize_hotel_whatsapp_connection), to prove the fix holds without
-- regressing any of that already-tested behavior. It does not replace
-- either of those two files, and hotel_whatsapp_connection_secrets_check.sql
-- is deliberately left untouched (task section 8) — once 0027 is applied,
-- that file must pass with no workaround of its own.

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
  values ('WA Ambiguity Test Hotel A', 'wa-ambiguity-test-hotel-a', 'ps_live_wa_ambiguity_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Ambiguity Test Hotel B', 'wa-ambiguity-test-hotel-b', 'ps_live_wa_ambiguity_test_b', 'active', true)
  returning id into hotel_b;

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%)', hotel_a, hotel_b;
end $$;

-- ================================================================
-- 1/2) Indirect call via finalize_hotel_whatsapp_connection_with_secret()
-- no longer raises 42702, and the first number for a hotel is active+primary.
--
-- DIAGNOSTIC NOTE: this call is DELIBERATELY left WITHOUT a
-- `begin ... exception when sqlstate '42702' ...` wrapper around it. A
-- prior version of this test caught 42702 here and re-raised a generic
-- "0027 fix did not take effect" message — that handler discarded
-- PostgreSQL's own native diagnostics (the exact failing QUERY:, the exact
-- PL/pgSQL function name + line number, and the exact ambiguous column
-- name), all of which Postgres attaches automatically to an uncaught error
-- as CONTEXT when it propagates out of an unhandled do $$ block. Catching
-- it and replacing it with our own message actively hid the one thing
-- needed to find a REMAINING ambiguity (if any survives 0027) — so this
-- call is left to fail LOUDLY and natively if it still fails, on purpose.
-- ================================================================
do $$
declare
  hotel_a uuid;
  conn_id uuid;
  conn_status text;
  conn_is_primary boolean;
  conn_connected_at timestamptz;
begin
  select id into hotel_a from public.hotels where slug = 'wa-ambiguity-test-hotel-a';

  select f.id, f.status, f.is_primary, f.connected_at
  into conn_id, conn_status, conn_is_primary, conn_connected_at
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-1'::text, 'amb-phone-1'::text, 'biz-1'::text, 'coexistence'::text,
    '\xAABBCCDDEE'::bytea, '\x000000000000000000000001'::bytea, '\x00000000000000000000000000000001'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  ) f;

  raise notice 'OK: [1] no 42702 raised through finalize_hotel_whatsapp_connection_with_secret';

  if conn_status <> 'active' or conn_is_primary is not true then
    raise exception 'BUG: [2] expected the first connection for hotel_a to be active+primary, got status=% is_primary=%', conn_status, conn_is_primary;
  end if;
  if conn_connected_at is null then
    raise exception 'BUG: [2] connected_at must be set on first activation';
  end if;
  raise notice 'OK: [2] first number for hotel_a is active + primary';
end $$;

-- ================================================================
-- 3) Second number for the SAME hotel is non-primary.
-- ================================================================
do $$
declare
  hotel_a uuid;
  conn_is_primary boolean;
begin
  select id into hotel_a from public.hotels where slug = 'wa-ambiguity-test-hotel-a';

  select f.is_primary into conn_is_primary
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-2'::text, 'amb-phone-2'::text, null::text, 'cloud_api_only'::text,
    '\xAA'::bytea, '\x000000000000000000000002'::bytea, '\x00000000000000000000000000000002'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  ) f;

  if conn_is_primary is not false then
    raise exception 'BUG: [3] a second active connection for the same hotel must NOT become primary, got is_primary=%', conn_is_primary;
  end if;
  raise notice 'OK: [3] second number for hotel_a is non-primary';
end $$;

-- ================================================================
-- 4/6) Retry on the SAME hotel + phone_number_id is idempotent, and
-- connected_at is preserved.
-- ================================================================
do $$
declare
  hotel_a uuid;
  original_conn_id uuid;
  original_connected_at timestamptz;
  retry_conn_id uuid;
  retry_connected_at timestamptz;
begin
  select id into hotel_a from public.hotels where slug = 'wa-ambiguity-test-hotel-a';

  select id, connected_at into original_conn_id, original_connected_at
  from public.hotel_whatsapp_connections
  where hotel_id = hotel_a and phone_number_id = 'amb-phone-1';

  select f.id, f.connected_at into retry_conn_id, retry_connected_at
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-1-rotated'::text, 'amb-phone-1'::text, 'biz-1'::text, 'coexistence'::text,
    '\xFFEEDD'::bytea, '\x000000000000000000000003'::bytea, '\x00000000000000000000000000000003'::bytea,
    'v2'::text, 1::smallint, null::timestamptz
  ) f;

  if retry_conn_id <> original_conn_id then
    raise exception 'BUG: [4] retry on the same hotel + phone_number_id created a DIFFERENT connection_id (got %, expected %)', retry_conn_id, original_conn_id;
  end if;
  raise notice 'OK: [4] retry on the same hotel + phone_number_id is idempotent';

  if retry_connected_at <> original_connected_at then
    raise exception 'BUG: [6] connected_at was not preserved across the retry (got %, expected %)', retry_connected_at, original_connected_at;
  end if;
  raise notice 'OK: [6] connected_at preserved across the retry';
end $$;

-- ================================================================
-- 5) Cross-tenant is still rejected — the fix must not have loosened this.
-- ================================================================
do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  before_waba text;
begin
  select id into hotel_a from public.hotels where slug = 'wa-ambiguity-test-hotel-a';
  select id into hotel_b from public.hotels where slug = 'wa-ambiguity-test-hotel-b';

  select waba_id into before_waba from public.hotel_whatsapp_connections where phone_number_id = 'amb-phone-1';

  begin
    perform public.finalize_hotel_whatsapp_connection_with_secret(
      hotel_b::uuid, 'waba-stolen'::text, 'amb-phone-1'::text, null::text, 'cloud_api_only'::text,
      '\xAA'::bytea, '\x000000000000000000000004'::bytea, '\x00000000000000000000000000000004'::bytea,
      'v1'::text, 1::smallint, null::timestamptz
    );
    raise exception 'SECURITY BUG: [5] hotel_b was allowed to claim amb-phone-1, already linked to hotel_a';
  exception
    when others then
      if sqlerrm <> 'phone_number_cross_tenant' then
        raise exception 'BUG: [5] expected phone_number_cross_tenant, got: %', sqlerrm;
      end if;
      raise notice 'OK: [5] cross-tenant attempt still rejected (phone_number_cross_tenant)';
  end;

  if (select waba_id from public.hotel_whatsapp_connections where phone_number_id = 'amb-phone-1') <> before_waba then
    raise exception 'BUG: [5] hotel_a''s connection was mutated by the rejected cross-tenant attempt';
  end if;
  raise notice 'OK: [5] hotel_a''s connection remains intact after the rejected cross-tenant attempt';
end $$;

-- ================================================================
-- 7/8) service_role still cannot call finalize_hotel_whatsapp_connection()
-- directly, and the 0026 composite RPC remains callable by service_role.
-- ================================================================
do $$
declare
  hotel_a uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-ambiguity-test-hotel-a';

  if has_function_privilege('service_role', 'public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text)', 'EXECUTE') then
    raise exception 'SECURITY BUG: [7] service_role has EXECUTE on finalize_hotel_whatsapp_connection after 0027 — CREATE OR REPLACE FUNCTION must not have re-granted it';
  end if;

  execute format('set local role service_role');
  begin
    perform public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-direct-probe', 'amb-phone-direct-probe', null, 'cloud_api_only');
    raise exception 'SECURITY BUG: [7] service_role was able to call finalize_hotel_whatsapp_connection directly after 0027';
  exception
    when insufficient_privilege then
      raise notice 'OK: [7] service_role still rejected at the EXECUTE grant level when calling finalize_hotel_whatsapp_connection directly';
  end;
  reset role;

  if not has_function_privilege('service_role', 'public.finalize_hotel_whatsapp_connection_with_secret(uuid, text, text, text, text, bytea, bytea, bytea, text, smallint, timestamptz)', 'EXECUTE') then
    raise exception 'BUG: [8] service_role lost EXECUTE on finalize_hotel_whatsapp_connection_with_secret after 0027';
  end if;

  execute format('set local role service_role');
  perform public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-composite-probe'::text, 'amb-phone-composite-probe'::text, null::text, 'cloud_api_only'::text,
    '\xAA'::bytea, '\x000000000000000000000005'::bytea, '\x00000000000000000000000000000005'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  );
  reset role;
  raise notice 'OK: [8] the 0026 composite RPC remains callable by service_role after 0027';
end $$;

-- ================================================================
-- 9) No remaining unaliased-and-ambiguous table reference in the deployed
-- function body — structural check on the ACTUAL function definition
-- (pg_get_functiondef), not just a behavioral pass/fail on the calls above.
-- Specifically: `public.hotels` must never appear without an alias
-- immediately followed by a bare `where <ident> =` — the exact shape that
-- caused the original 42702.
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
    raise exception 'BUG: [9] finalize_hotel_whatsapp_connection not found';
  end if;

  -- Plain, whitespace-normalized SUBSTRING search (position()), not a
  -- hand-rolled regex — this check originally used
  -- `~* 'from\s+public\.hotels\s+h\b'`, which ALWAYS failed to find a real,
  -- present match: in PostgreSQL's regex dialect (Advanced Regular
  -- Expressions), `\b` is NOT a word-boundary constraint like in
  -- PCRE/JavaScript — it is the BACKSPACE character-entry escape (0x08).
  -- The pattern was therefore silently searching for the literal
  -- sequence "h" + a backspace byte, which obviously never occurs in the
  -- source text, no matter how correct the deployed alias was. Word
  -- boundary in Postgres ARE would have been `\y`, not `\b` — but rather
  -- than juggle a third regex dialect subtlety in this file (after the
  -- `\(`/`\)` conflict-target issue and the doc-comment substring false
  -- positive, both fixed in the 0028 test), this uses the same
  -- comment-stripped, whitespace-collapsed position() technique already
  -- proven correct there.
  v_normalized := regexp_replace(regexp_replace(lower(v_def), '--[^\n]*', '', 'g'), '\s+', ' ', 'g');

  if position('from public.hotels where' in v_normalized) > 0 then
    raise exception 'BUG: [9] the deployed function still references public.hotels without an alias before WHERE — the exact shape that caused 42702: %', v_def;
  end if;
  if position('from public.hotels h where' in v_normalized) = 0 then
    raise exception 'BUG: [9] the expected `public.hotels h` alias was not found in the deployed function body: %', v_def;
  end if;
  raise notice 'OK: [9] no unaliased public.hotels reference remains in the deployed function body';
end $$;

rollback;
