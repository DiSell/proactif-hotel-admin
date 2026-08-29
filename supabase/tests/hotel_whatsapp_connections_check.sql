-- Constraint/behavior checks for
-- 0024_hotel_whatsapp_connections.sql — run this in the Supabase SQL
-- editor (or psql connected to the project) AFTER that migration has been
-- applied (which itself requires 0001-0023 already applied, for
-- public.hotels/set_updated_at()/is_superadmin()/is_hotel_admin_for()).
--
-- BEGIN/ROLLBACK, same style as every other test script in this project —
-- everything this script writes is rolled back at the end. No real
-- project data is touched.
--
-- UNLIKE partner_requests_check.sql / partner_request_deliveries_check.sql,
-- this table has NO SECURITY DEFINER RPC at all (0024's own design: write
-- access is fully closed for every role, including service_role, until a
-- future migration adds the real finalization RPC alongside the Meta
-- exchange code that does not exist yet) — so every constraint below is
-- exercised via DIRECT INSERT/UPDATE, run as this script's own (superuser)
-- connection, exactly like hotel_partners_check.sql does for a table with
-- the same "no RPC-only discipline (yet)" shape. This is intentional, not
-- an oversight: there is nothing to route through yet.

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  conn_1 uuid;
  conn_3 uuid;
  count_check integer;
  updated_at_check timestamptz;
  v_constraint_def text;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Connections Test Hotel A', 'wa-connections-test-hotel-a', 'ps_live_wa_conn_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Connections Test Hotel B', 'wa-connections-test-hotel-b', 'ps_live_wa_conn_test_b', 'active', true)
  returning id into hotel_b;

  raise notice 'OK: fixtures created';

  -- ================================================================
  -- 1) FK to hotels — a connection can never reference a non-existent
  -- hotel_id.
  -- ================================================================
  begin
    insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status)
    values ('00000000-0000-0000-0000-000000000000', 'waba-x', 'phone-x', 'cloud_api_only', 'pending');
    raise exception 'BUG: a connection was created for a non-existent hotel_id';
  exception
    when foreign_key_violation then
      raise notice 'OK: hotel_id FK rejects a non-existent hotel';
  end;

  -- ================================================================
  -- 2) connection_type CHECK constraint.
  -- ================================================================
  begin
    insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status)
    values (hotel_a, 'waba-1', 'phone-bad-type', 'not_a_real_type', 'pending');
    raise exception 'BUG: an invalid connection_type value was accepted';
  exception
    when check_violation then
      raise notice 'OK: connection_type CHECK constraint rejects an unknown value';
  end;

  -- ================================================================
  -- 3) status CHECK constraint.
  -- ================================================================
  begin
    insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status)
    values (hotel_a, 'waba-1', 'phone-bad-status', 'cloud_api_only', 'not_a_real_status');
    raise exception 'BUG: an invalid status value was accepted';
  exception
    when check_violation then
      raise notice 'OK: status CHECK constraint rejects an unknown value';
  end;

  -- ================================================================
  -- 4) phone_number_id unique GLOBALLY — two different hotels can never
  -- share the same Meta phone number.
  -- ================================================================
  insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status, is_primary)
  values (hotel_a, 'waba-1', 'phone-shared', 'cloud_api_only', 'pending', true)
  returning id into conn_1;

  begin
    insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status)
    values (hotel_b, 'waba-2', 'phone-shared', 'cloud_api_only', 'pending');
    raise exception 'BUG: two different hotels were allowed to share the same phone_number_id';
  exception
    when unique_violation then
      raise notice 'OK: phone_number_id uniqueness enforced across hotels';
  end;

  -- Same hotel, same phone_number_id again — also rejected (re-onboarding
  -- the SAME number must update the existing row, never insert a
  -- duplicate).
  begin
    insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status)
    values (hotel_a, 'waba-1', 'phone-shared', 'cloud_api_only', 'pending');
    raise exception 'BUG: the same hotel was allowed to duplicate an existing phone_number_id row';
  exception
    when unique_violation then
      raise notice 'OK: phone_number_id uniqueness also prevents same-hotel duplicate onboarding attempts';
  end;

  -- ================================================================
  -- 5) The SAME waba_id can carry multiple phone_number_id rows — waba_id
  -- is deliberately never unique on its own.
  -- ================================================================
  insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status, is_primary)
  values (hotel_a, 'waba-1', 'phone-second', 'cloud_api_only', 'active', false)
  returning id into conn_3;
  raise notice 'OK: the same waba_id can be shared by multiple phone_number_id rows';

  -- ================================================================
  -- 6) Multiple ACTIVE connections for the same hotel are possible, as
  -- long as at most one of them is primary.
  -- ================================================================
  update public.hotel_whatsapp_connections set status = 'active' where id = conn_1; -- conn_1 stays primary + becomes active
  -- conn_3 (inserted above, is_primary = false) is ALSO active — two
  -- active rows for hotel_a coexisting.
  select count(*) into count_check from public.hotel_whatsapp_connections where hotel_id = hotel_a and status = 'active';
  if count_check <> 2 then
    raise exception 'BUG: expected exactly 2 active connections for hotel_a, found %', count_check;
  end if;
  raise notice 'OK: a hotel can have multiple active connections as long as only one is primary';

  -- ================================================================
  -- 7) Two ACTIVE + PRIMARY connections for the same hotel are forbidden.
  -- ================================================================
  begin
    insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status, is_primary)
    values (hotel_a, 'waba-3', 'phone-third', 'cloud_api_only', 'active', true);
    raise exception 'BUG: a second active+primary connection was created for the same hotel';
  exception
    when unique_violation then
      raise notice 'OK: at most one active+primary connection per hotel enforced';
  end;

  -- A non-primary active insert for the SAME hotel still succeeds
  -- (proves the index above is scoped to is_primary = true, not to
  -- "active" alone).
  insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status, is_primary)
  values (hotel_a, 'waba-3', 'phone-third', 'cloud_api_only', 'active', false);
  raise notice 'OK: a non-primary active connection for the same hotel is never blocked by the primary-active index';

  -- ================================================================
  -- 8) unique(id, hotel_id) present — verified via the catalog, the exact
  -- composite key a future child table would reference.
  -- ================================================================
  select count(*) into count_check
  from pg_constraint
  where conrelid = 'public.hotel_whatsapp_connections'::regclass
    and conname = 'hotel_whatsapp_connections_id_hotel_id_key'
    and contype = 'u';
  if count_check <> 1 then
    raise exception 'BUG: hotel_whatsapp_connections_id_hotel_id_key not found';
  end if;
  raise notice 'OK: unique(id, hotel_id) exists for future tenant-safe composite FKs';

  -- ================================================================
  -- 9) updated_at trigger — verified two ways: (a) the trigger genuinely
  -- exists and calls set_updated_at(), and (b) it actively overrides any
  -- caller-supplied value on UPDATE. NOTE: comparing updated_at
  -- before/after via now() would NOT reliably prove this — now() is fixed
  -- for the whole duration of this transaction in PostgreSQL, so a naive
  -- before/after timestamp comparison could look "unchanged" even when
  -- the trigger fires correctly. Attempting to set an obviously-wrong,
  -- hardcoded past timestamp and confirming the trigger overwrites it
  -- sidesteps that entirely.
  -- ================================================================
  select count(*) into count_check
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  where t.tgrelid = 'public.hotel_whatsapp_connections'::regclass
    and p.proname = 'set_updated_at'
    and not t.tgisinternal;
  if count_check <> 1 then
    raise exception 'BUG: expected exactly one set_updated_at trigger on hotel_whatsapp_connections, found %', count_check;
  end if;

  update public.hotel_whatsapp_connections set status = 'error', updated_at = '2000-01-01'::timestamptz where id = conn_1;
  select updated_at into updated_at_check from public.hotel_whatsapp_connections where id = conn_1;
  if updated_at_check = '2000-01-01'::timestamptz then
    raise exception 'BUG: set_updated_at trigger did not override a caller-supplied updated_at value';
  end if;
  raise notice 'OK: set_updated_at trigger is wired up and actively overrides any caller-supplied value';

  -- ================================================================
  -- 10) RLS enabled.
  -- ================================================================
  select count(*) into count_check
  from pg_class
  where oid = 'public.hotel_whatsapp_connections'::regclass
    and relrowsecurity = true;
  if count_check <> 1 then
    raise exception 'BUG: row level security is not enabled on hotel_whatsapp_connections';
  end if;
  raise notice 'OK: RLS enabled';

  -- ================================================================
  -- 11) anon has NO access at all; authenticated has SELECT but never a
  -- direct write; service_role has SELECT but never a direct write either
  -- (this table is fully write-locked pending a future finalization RPC —
  -- see this migration's own header comment).
  -- ================================================================
  if has_table_privilege('anon', 'public.hotel_whatsapp_connections', 'SELECT')
     or has_table_privilege('anon', 'public.hotel_whatsapp_connections', 'INSERT')
     or has_table_privilege('anon', 'public.hotel_whatsapp_connections', 'UPDATE')
     or has_table_privilege('anon', 'public.hotel_whatsapp_connections', 'DELETE') then
    raise exception 'BUG: anon has some privilege on hotel_whatsapp_connections';
  end if;

  if not has_table_privilege('authenticated', 'public.hotel_whatsapp_connections', 'SELECT') then
    raise exception 'BUG: authenticated is missing its own intended SELECT grant';
  end if;
  if has_table_privilege('authenticated', 'public.hotel_whatsapp_connections', 'INSERT')
     or has_table_privilege('authenticated', 'public.hotel_whatsapp_connections', 'UPDATE')
     or has_table_privilege('authenticated', 'public.hotel_whatsapp_connections', 'DELETE') then
    raise exception 'BUG: authenticated unexpectedly has a direct write privilege';
  end if;

  if has_table_privilege('service_role', 'public.hotel_whatsapp_connections', 'INSERT')
     or has_table_privilege('service_role', 'public.hotel_whatsapp_connections', 'UPDATE')
     or has_table_privilege('service_role', 'public.hotel_whatsapp_connections', 'DELETE') then
    raise exception 'BUG: service_role unexpectedly has a direct write privilege — this table must stay fully write-locked until a real finalization RPC exists';
  end if;
  raise notice 'OK: anon has no access at all; authenticated/service_role have SELECT only, no direct write for anyone';

  -- ================================================================
  -- 12) No secret/token column exists on this table at all.
  -- ================================================================
  select count(*) into count_check
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'hotel_whatsapp_connections'
    and column_name in ('access_token', 'refresh_token', 'authorization_code', 'app_secret', 'verify_token', 'system_user_token', 'credential', 'secret');
  if count_check <> 0 then
    raise exception 'BUG: a secret-shaped column exists on hotel_whatsapp_connections';
  end if;
  raise notice 'OK: no secret/token column exists on hotel_whatsapp_connections';

  raise notice 'OK: all hotel_whatsapp_connections checks passed';
end $$;

rollback;
