-- Constraint/behavior checks for
-- 0026_hotel_whatsapp_connection_secrets.sql — run this in the Supabase SQL
-- editor (or psql connected to the project) AFTER 0024, 0025 AND 0026 have
-- all been applied.
--
-- BEGIN/ROLLBACK, same style as every other test script in this project.
-- No real project data is touched.
--
-- NOTE ON WHAT IS NOT TESTED HERE (task section 20): this migration stores
-- ciphertext only and never encrypts/decrypts anything — there is no
-- "does this look like a real Meta token" check anywhere below, since that
-- would test nothing cryptographically meaningful. Real crypto tests
-- (encrypt/decrypt round-trip, tamper detection, wrong AAD, wrong key,
-- nonce randomness) belong to the future Node-side helper's own test file,
-- not this SQL script.

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
  values ('WA Secrets Test Hotel A', 'wa-secrets-test-hotel-a', 'ps_live_wa_secrets_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Secrets Test Hotel B', 'wa-secrets-test-hotel-b', 'ps_live_wa_secrets_test_b', 'active', true)
  returning id into hotel_b;

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%)', hotel_a, hotel_b;
end $$;

-- ================================================================
-- 1) table created.
-- ================================================================
do $$
begin
  if to_regclass('public.hotel_whatsapp_connection_secrets') is null then
    raise exception 'BUG: public.hotel_whatsapp_connection_secrets does not exist';
  end if;
  raise notice 'OK: [1] hotel_whatsapp_connection_secrets exists';
end $$;

-- ================================================================
-- 2) FK composite tenant-safe: (connection_id, hotel_id) -> hotel_whatsapp_connections(id, hotel_id).
--
-- Checked via pg_constraint/pg_attribute catalog data ONLY — never via a
-- substring match on pg_get_constraintdef()'s rendered text. That renderer
-- omits the `public.` schema prefix whenever the referenced table is
-- already resolvable on the current search_path (which it is here, inside
-- a plain do $$ block with no search_path override) — a fixed-text
-- expectation of `public.hotel_whatsapp_connections(id, hotel_id)` in the
-- rendered string is therefore a FALSE NEGATIVE waiting to happen: the FK
-- can be exactly correct while the human-readable definition simply omits
-- a schema qualifier that was never semantically required. Comparing
-- conrelid/confrelid via ::regclass equality, confdeltype directly, and
-- the actual attnum -> attname resolution of conkey/confkey is immune to
-- that rendering detail entirely.
-- ================================================================
do $$
declare
  v_conrelid regclass;
  v_confrelid regclass;
  v_contype text;
  v_confdeltype text;
  v_conkey smallint[];
  v_confkey smallint[];
  v_local_cols text[];
  v_foreign_cols text[];
begin
  select c.conrelid, c.confrelid, c.contype, c.confdeltype, c.conkey, c.confkey
  into v_conrelid, v_confrelid, v_contype, v_confdeltype, v_conkey, v_confkey
  from pg_constraint c
  where c.conname = 'hotel_whatsapp_connection_secrets_connection_fk'
    and c.conrelid = 'public.hotel_whatsapp_connection_secrets'::regclass;

  if v_conrelid is null then
    raise exception 'BUG: hotel_whatsapp_connection_secrets_connection_fk not found';
  end if;
  if v_contype <> 'f' then
    raise exception 'BUG: hotel_whatsapp_connection_secrets_connection_fk is not a FOREIGN KEY (contype=%)', v_contype;
  end if;
  if v_confrelid <> 'public.hotel_whatsapp_connections'::regclass then
    raise exception 'BUG: FK does not reference public.hotel_whatsapp_connections (got %)', v_confrelid::text;
  end if;
  if v_confdeltype <> 'c' then
    raise exception 'BUG: FK is not ON DELETE CASCADE (confdeltype=%)', v_confdeltype;
  end if;

  -- Resolve the actual referencing/referenced column NAMES from their
  -- attnum arrays, preserving declared order — the real, unambiguous
  -- source of truth for "which columns", independent of any rendering.
  select array_agg(a.attname order by ord.n)
  into v_local_cols
  from unnest(v_conkey) with ordinality as ord(attnum, n)
  join pg_attribute a on a.attrelid = v_conrelid and a.attnum = ord.attnum;

  select array_agg(a.attname order by ord.n)
  into v_foreign_cols
  from unnest(v_confkey) with ordinality as ord(attnum, n)
  join pg_attribute a on a.attrelid = v_confrelid and a.attnum = ord.attnum;

  if v_local_cols <> array['connection_id', 'hotel_id'] then
    raise exception 'BUG: FK local columns are not exactly (connection_id, hotel_id), got %', v_local_cols;
  end if;
  if v_foreign_cols <> array['id', 'hotel_id'] then
    raise exception 'BUG: FK referenced columns are not exactly (id, hotel_id), got %', v_foreign_cols;
  end if;

  raise notice 'OK: [2] composite tenant-safe FK confirmed structurally via catalog data: (%) references public.hotel_whatsapp_connections(%) ON DELETE CASCADE',
    array_to_string(v_local_cols, ','), array_to_string(v_foreign_cols, ',');
end $$;

-- ================================================================
-- 3) UNIQUE(connection_id).
-- ================================================================
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from pg_constraint
  where conname = 'hotel_whatsapp_connection_secrets_connection_id_key'
    and conrelid = 'public.hotel_whatsapp_connection_secrets'::regclass
    and contype = 'u';
  if v_count <> 1 then
    raise exception 'BUG: unique(connection_id) not found on hotel_whatsapp_connection_secrets';
  end if;
  raise notice 'OK: [3] unique(connection_id) confirmed';
end $$;

-- ================================================================
-- 4) RLS enabled.
-- ================================================================
do $$
begin
  if not (select relrowsecurity from pg_class where oid = 'public.hotel_whatsapp_connection_secrets'::regclass) then
    raise exception 'BUG: RLS not enabled on hotel_whatsapp_connection_secrets';
  end if;
  raise notice 'OK: [4] RLS enabled';
end $$;

-- ================================================================
-- 5-10) Zero direct table privilege for anon / authenticated / service_role
-- (SELECT/INSERT/UPDATE/DELETE each).
-- ================================================================
do $$
declare
  leaked text := '';
begin
  if has_table_privilege('anon', 'public.hotel_whatsapp_connection_secrets', 'SELECT') then leaked := leaked || 'anon:SELECT '; end if;
  if has_table_privilege('anon', 'public.hotel_whatsapp_connection_secrets', 'INSERT') then leaked := leaked || 'anon:INSERT '; end if;
  if has_table_privilege('anon', 'public.hotel_whatsapp_connection_secrets', 'UPDATE') then leaked := leaked || 'anon:UPDATE '; end if;
  if has_table_privilege('anon', 'public.hotel_whatsapp_connection_secrets', 'DELETE') then leaked := leaked || 'anon:DELETE '; end if;
  if leaked <> '' then
    raise exception 'SECURITY BUG: [5] anon has privilege on hotel_whatsapp_connection_secrets: %', leaked;
  end if;
  raise notice 'OK: [5] anon has zero privilege on hotel_whatsapp_connection_secrets';
end $$;

do $$
declare
  leaked text := '';
begin
  if has_table_privilege('authenticated', 'public.hotel_whatsapp_connection_secrets', 'SELECT') then leaked := leaked || 'authenticated:SELECT '; end if;
  if has_table_privilege('authenticated', 'public.hotel_whatsapp_connection_secrets', 'INSERT') then leaked := leaked || 'authenticated:INSERT '; end if;
  if has_table_privilege('authenticated', 'public.hotel_whatsapp_connection_secrets', 'UPDATE') then leaked := leaked || 'authenticated:UPDATE '; end if;
  if has_table_privilege('authenticated', 'public.hotel_whatsapp_connection_secrets', 'DELETE') then leaked := leaked || 'authenticated:DELETE '; end if;
  if leaked <> '' then
    raise exception 'SECURITY BUG: [6] authenticated has privilege on hotel_whatsapp_connection_secrets: %', leaked;
  end if;
  raise notice 'OK: [6] authenticated has zero privilege on hotel_whatsapp_connection_secrets';
end $$;

do $$
begin
  if has_table_privilege('service_role', 'public.hotel_whatsapp_connection_secrets', 'SELECT') then
    raise exception 'SECURITY BUG: [7] service_role has direct SELECT on hotel_whatsapp_connection_secrets';
  end if;
  raise notice 'OK: [7] service_role has no direct SELECT on hotel_whatsapp_connection_secrets';
end $$;

do $$
begin
  if has_table_privilege('service_role', 'public.hotel_whatsapp_connection_secrets', 'INSERT') then
    raise exception 'SECURITY BUG: [8] service_role has direct INSERT on hotel_whatsapp_connection_secrets';
  end if;
  raise notice 'OK: [8] service_role has no direct INSERT on hotel_whatsapp_connection_secrets';
end $$;

do $$
begin
  if has_table_privilege('service_role', 'public.hotel_whatsapp_connection_secrets', 'UPDATE') then
    raise exception 'SECURITY BUG: [9] service_role has direct UPDATE on hotel_whatsapp_connection_secrets';
  end if;
  raise notice 'OK: [9] service_role has no direct UPDATE on hotel_whatsapp_connection_secrets';
end $$;

do $$
begin
  if has_table_privilege('service_role', 'public.hotel_whatsapp_connection_secrets', 'DELETE') then
    raise exception 'SECURITY BUG: [10] service_role has direct DELETE on hotel_whatsapp_connection_secrets';
  end if;
  raise notice 'OK: [10] service_role has no direct DELETE on hotel_whatsapp_connection_secrets';
end $$;

-- ================================================================
-- 11) service_role can no longer call finalize_hotel_whatsapp_connection
-- (0025) DIRECTLY — hardened by this migration.
-- 12) service_role CAN call the new composite RPC (0026).
-- ================================================================
do $$
declare
  hotel_a uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-secrets-test-hotel-a';

  if has_function_privilege('service_role', 'public.finalize_hotel_whatsapp_connection(uuid, text, text, text, text)', 'EXECUTE') then
    raise exception 'SECURITY BUG: [11] service_role still has EXECUTE on finalize_hotel_whatsapp_connection after 0026''s hardening';
  end if;

  execute format('set local role service_role');
  begin
    perform public.finalize_hotel_whatsapp_connection(hotel_a, 'waba-direct-probe', 'phone-direct-probe', null, 'cloud_api_only');
    raise exception 'SECURITY BUG: [11] service_role was able to call finalize_hotel_whatsapp_connection directly';
  exception
    when insufficient_privilege then
      raise notice 'OK: [11] service_role rejected at the EXECUTE grant level when calling 0025 directly (insufficient_privilege)';
  end;
  reset role;

  if not has_function_privilege('service_role', 'public.finalize_hotel_whatsapp_connection_with_secret(uuid, text, text, text, text, bytea, bytea, bytea, text, smallint, timestamptz)', 'EXECUTE') then
    raise exception 'BUG: [12] service_role is missing EXECUTE on finalize_hotel_whatsapp_connection_with_secret';
  end if;

  execute format('set local role service_role');
  perform public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-execute-probe'::text, 'phone-execute-probe'::text, null::text, 'cloud_api_only'::text,
    '\xAABBCC'::bytea, '\x000000000000000000000001'::bytea, '\x00000000000000000000000000000001'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  );
  reset role;
  raise notice 'OK: [12] service_role can call finalize_hotel_whatsapp_connection_with_secret';
end $$;

-- ================================================================
-- 13/14/15) First finalization creates BOTH the connection and the secret,
-- connection is active, secret is linked to the right connection_id/hotel_id.
-- ================================================================
do $$
declare
  hotel_a uuid;
  conn_id uuid;
  conn_status text;
  conn_connected_at timestamptz;
  secret_connection_id uuid;
  secret_hotel_id uuid;
  secret_obtained_at timestamptz;
  secret_last_rotated_at timestamptz;
begin
  select id into hotel_a from public.hotels where slug = 'wa-secrets-test-hotel-a';

  select f.id, f.status, f.connected_at
  into conn_id, conn_status, conn_connected_at
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-1'::text, 'sec-phone-1'::text, 'biz-1'::text, 'coexistence'::text,
    '\xAABBCCDDEE'::bytea, '\x000000000000000000000002'::bytea, '\x00000000000000000000000000000002'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  ) f;

  if conn_status <> 'active' then
    raise exception 'BUG: [14] expected connection status active, got %', conn_status;
  end if;
  if conn_connected_at is null then
    raise exception 'BUG: [14] connected_at must be set on first activation';
  end if;
  raise notice 'OK: [13/14] first finalization creates an active connection';

  select connection_id, hotel_id, obtained_at, last_rotated_at
  into secret_connection_id, secret_hotel_id, secret_obtained_at, secret_last_rotated_at
  from public.hotel_whatsapp_connection_secrets
  where connection_id = conn_id;

  if secret_connection_id is null then
    raise exception 'BUG: [13] no secret row was created for the finalized connection';
  end if;
  if secret_connection_id <> conn_id or secret_hotel_id <> hotel_a then
    raise exception 'BUG: [15] secret is not linked to the correct connection_id/hotel_id';
  end if;
  if secret_obtained_at is null then
    raise exception 'BUG: obtained_at must be set on first storage';
  end if;
  if secret_last_rotated_at is not null then
    raise exception 'BUG: last_rotated_at must be null on first storage, got %', secret_last_rotated_at;
  end if;
  raise notice 'OK: [15] secret correctly linked to connection_id=% / hotel_id=%', secret_connection_id, secret_hotel_id;
end $$;

-- ================================================================
-- 16/17) Fail-closed: an invalid nonce length aborts the ENTIRE call,
-- including the internal finalize_hotel_whatsapp_connection() write — no
-- orphan active connection is left behind for this phone_number_id.
-- ================================================================
do $$
declare
  hotel_a uuid;
  orphan_count integer;
begin
  select id into hotel_a from public.hotels where slug = 'wa-secrets-test-hotel-a';

  begin
    perform public.finalize_hotel_whatsapp_connection_with_secret(
      hotel_a::uuid, 'waba-fail'::text, 'sec-phone-fail'::text, null::text, 'cloud_api_only'::text,
      '\xAABB'::bytea,
      '\x0011'::bytea, -- 2 bytes, not 12 -- must fail the nonce length CHECK
      '\x00000000000000000000000000000003'::bytea, 'v1'::text, 1::smallint, null::timestamptz
    );
    raise exception 'BUG: [16] an invalid nonce length was accepted by finalize_hotel_whatsapp_connection_with_secret';
  exception
    when check_violation then
      raise notice 'OK: [16] invalid nonce length rejected (check_violation), whole call aborted';
  end;

  select count(*) into orphan_count
  from public.hotel_whatsapp_connections
  where phone_number_id = 'sec-phone-fail';

  if orphan_count <> 0 then
    raise exception 'BUG: [17] the internal finalize_hotel_whatsapp_connection() write was NOT rolled back — % orphan connection row(s) found for sec-phone-fail', orphan_count;
  end if;
  raise notice 'OK: [17] no orphan active connection exists after the secret write failed — atomicity confirmed';
end $$;

-- ================================================================
-- 18-23) Idempotence + rotation on the SAME hotel + phone_number_id.
-- ================================================================
do $$
declare
  hotel_a uuid;
  conn_id uuid;
  original_conn_id uuid;
  original_connected_at timestamptz;
  original_obtained_at timestamptz;
  retry_connected_at timestamptz;
  retry_obtained_at timestamptz;
  retry_last_rotated_at timestamptz;
  retry_ciphertext bytea;
begin
  select id into hotel_a from public.hotels where slug = 'wa-secrets-test-hotel-a';

  select f.id into original_conn_id
  from public.hotel_whatsapp_connections f
  where f.phone_number_id = 'sec-phone-1' and f.hotel_id = hotel_a;

  select connected_at into original_connected_at from public.hotel_whatsapp_connections where id = original_conn_id;
  select obtained_at into original_obtained_at from public.hotel_whatsapp_connection_secrets where connection_id = original_conn_id;

  -- Retry with a DIFFERENT ciphertext (simulating a rotation) for the SAME
  -- hotel + phone_number_id.
  select f.id, f.connected_at
  into conn_id, retry_connected_at
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_a::uuid, 'waba-1-rotated'::text, 'sec-phone-1'::text, 'biz-1'::text, 'coexistence'::text,
    '\xFFEEDDCCBBAA'::bytea, '\x000000000000000000000009'::bytea, '\x00000000000000000000000000000009'::bytea,
    'v2'::text, 1::smallint, null::timestamptz
  ) f;

  if conn_id <> original_conn_id then
    raise exception 'BUG: [19] idempotent re-finalization created a DIFFERENT connection_id (got %, expected %)', conn_id, original_conn_id;
  end if;
  if retry_connected_at <> original_connected_at then
    raise exception 'BUG: [20] connected_at was not preserved across the retry';
  end if;
  raise notice 'OK: [18/19/20] same hotel + phone_number_id is idempotent, connection_id and connected_at preserved';

  select obtained_at, last_rotated_at, ciphertext
  into retry_obtained_at, retry_last_rotated_at, retry_ciphertext
  from public.hotel_whatsapp_connection_secrets
  where connection_id = conn_id;

  if retry_obtained_at <> original_obtained_at then
    raise exception 'BUG: [21] obtained_at was not preserved across the secret rotation';
  end if;
  if retry_last_rotated_at is null then
    raise exception 'BUG: [23] last_rotated_at must be set after a rotation';
  end if;
  if retry_ciphertext <> '\xFFEEDDCCBBAA'::bytea then
    raise exception 'BUG: [22] ciphertext was not replaced by the rotation';
  end if;
  if (select count(*) from public.hotel_whatsapp_connection_secrets where connection_id = conn_id) <> 1 then
    raise exception 'BUG: a rotation created a SECOND secret row instead of replacing the existing one';
  end if;
  raise notice 'OK: [21/22/23] obtained_at preserved, ciphertext replaced, last_rotated_at updated, no duplicate secret row';
end $$;

-- ================================================================
-- 24-26) Cross-tenant rejection — same phone_number_id, different hotel.
-- ================================================================
do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  before_waba text;
  before_status text;
  after_waba text;
  after_status text;
begin
  select id into hotel_a from public.hotels where slug = 'wa-secrets-test-hotel-a';
  select id into hotel_b from public.hotels where slug = 'wa-secrets-test-hotel-b';

  select waba_id, status into before_waba, before_status
  from public.hotel_whatsapp_connections where phone_number_id = 'sec-phone-1';

  begin
    perform public.finalize_hotel_whatsapp_connection_with_secret(
      hotel_b::uuid, 'waba-stolen'::text, 'sec-phone-1'::text, null::text, 'cloud_api_only'::text,
      '\xAA'::bytea, '\x000000000000000000000004'::bytea, '\x00000000000000000000000000000004'::bytea,
      'v1'::text, 1::smallint, null::timestamptz
    );
    raise exception 'SECURITY BUG: [24] hotel_b was allowed to claim sec-phone-1, already linked to hotel_a';
  exception
    when others then
      if sqlerrm <> 'phone_number_cross_tenant' then
        raise exception 'BUG: [24] expected phone_number_cross_tenant, got: %', sqlerrm;
      end if;
      raise notice 'OK: [24] cross-tenant attempt raises phone_number_cross_tenant';
  end;

  select waba_id, status into after_waba, after_status
  from public.hotel_whatsapp_connections where phone_number_id = 'sec-phone-1';

  if after_waba <> before_waba or after_status <> before_status then
    raise exception 'BUG: [25] hotel_a''s connection was mutated by the rejected cross-tenant attempt';
  end if;
  raise notice 'OK: [25] hotel_a''s connection remains strictly intact';

  if exists (select 1 from public.hotel_whatsapp_connection_secrets where hotel_id = hotel_b) then
    raise exception 'BUG: [26] a secret was created for hotel_b despite the rejected cross-tenant attempt';
  end if;
  raise notice 'OK: [26] no secret was created for the rejected hotel';
end $$;

-- ================================================================
-- 27) expires_at NULL accepted.
-- ================================================================
do $$
declare
  hotel_b uuid;
  v_expires_at timestamptz;
  conn_id uuid;
begin
  select id into hotel_b from public.hotels where slug = 'wa-secrets-test-hotel-b';

  select f.id into conn_id
  from public.finalize_hotel_whatsapp_connection_with_secret(
    hotel_b::uuid, 'waba-b1'::text, 'sec-phone-b1'::text, null::text, 'cloud_api_only'::text,
    '\xAA'::bytea, '\x000000000000000000000005'::bytea, '\x00000000000000000000000000000005'::bytea,
    'v1'::text, 1::smallint, null::timestamptz
  ) f;

  select expires_at into v_expires_at from public.hotel_whatsapp_connection_secrets where connection_id = conn_id;
  if v_expires_at is not null then
    raise exception 'BUG: [27] expected expires_at to be null';
  end if;
  raise notice 'OK: [27] expires_at NULL accepted';
end $$;

-- ================================================================
-- 28/29/31/32) Structural CHECK constraints, tested via direct INSERT
-- (this script's own superuser connection, same convention as
-- hotel_whatsapp_connections_check.sql) against a dedicated, already-valid
-- connection row created solely for these constraint probes. Each attempt
-- is wrapped in its own begin/exception so a caught failure rolls back only
-- that one attempt (an implicit savepoint), leaving the connection_id free
-- for the next probe.
-- ================================================================
do $$
declare
  hotel_a uuid;
  probe_connection_id uuid;
begin
  select id into hotel_a from public.hotels where slug = 'wa-secrets-test-hotel-a';

  insert into public.hotel_whatsapp_connections (hotel_id, waba_id, phone_number_id, connection_type, status, is_primary)
  values (hotel_a, 'waba-constraint-probe', 'phone-constraint-probe', 'cloud_api_only', 'active', false)
  returning id into probe_connection_id;

  -- [28] key_id empty rejected.
  begin
    insert into public.hotel_whatsapp_connection_secrets (connection_id, hotel_id, ciphertext, nonce, auth_tag, key_id, encryption_version)
    values (probe_connection_id, hotel_a, '\xAA'::bytea, '\x000000000000000000000006'::bytea, '\x00000000000000000000000000000006'::bytea, '', 1);
    raise exception 'BUG: [28] an empty key_id was accepted';
  exception
    when check_violation then
      raise notice 'OK: [28] empty key_id rejected';
  end;

  -- [29] encryption_version <= 0 rejected.
  begin
    insert into public.hotel_whatsapp_connection_secrets (connection_id, hotel_id, ciphertext, nonce, auth_tag, key_id, encryption_version)
    values (probe_connection_id, hotel_a, '\xAA'::bytea, '\x000000000000000000000006'::bytea, '\x00000000000000000000000000000006'::bytea, 'v1', 0);
    raise exception 'BUG: [29] encryption_version = 0 was accepted';
  exception
    when check_violation then
      raise notice 'OK: [29] encryption_version <= 0 rejected';
  end;

  -- [30] nonce length != 12 rejected (structural probe, in addition to the
  -- end-to-end RPC test [16] above).
  begin
    insert into public.hotel_whatsapp_connection_secrets (connection_id, hotel_id, ciphertext, nonce, auth_tag, key_id, encryption_version)
    values (probe_connection_id, hotel_a, '\xAA'::bytea, '\x0011'::bytea, '\x00000000000000000000000000000006'::bytea, 'v1', 1);
    raise exception 'BUG: [30] a 2-byte nonce was accepted';
  exception
    when check_violation then
      raise notice 'OK: [30] nonce length != 12 rejected';
  end;

  -- [31] auth_tag length != 16 rejected.
  begin
    insert into public.hotel_whatsapp_connection_secrets (connection_id, hotel_id, ciphertext, nonce, auth_tag, key_id, encryption_version)
    values (probe_connection_id, hotel_a, '\xAA'::bytea, '\x000000000000000000000006'::bytea, '\x0011'::bytea, 'v1', 1);
    raise exception 'BUG: [31] a 2-byte auth_tag was accepted';
  exception
    when check_violation then
      raise notice 'OK: [31] auth_tag length != 16 rejected';
  end;

  -- [32] empty ciphertext rejected.
  begin
    insert into public.hotel_whatsapp_connection_secrets (connection_id, hotel_id, ciphertext, nonce, auth_tag, key_id, encryption_version)
    values (probe_connection_id, hotel_a, ''::bytea, '\x000000000000000000000006'::bytea, '\x00000000000000000000000000000006'::bytea, 'v1', 1);
    raise exception 'BUG: [32] an empty ciphertext was accepted';
  exception
    when check_violation then
      raise notice 'OK: [32] empty ciphertext rejected';
  end;
end $$;

-- ================================================================
-- 33-35) get_hotel_whatsapp_connection_secret — EXECUTE grants.
-- ================================================================
do $$
declare
  hotel_a uuid;
  conn_id uuid;
  v_ciphertext bytea;
begin
  select id into hotel_a from public.hotels where slug = 'wa-secrets-test-hotel-a';
  select id into conn_id from public.hotel_whatsapp_connections where phone_number_id = 'sec-phone-1';

  if has_function_privilege('authenticated', 'public.get_hotel_whatsapp_connection_secret(uuid, uuid)', 'EXECUTE') then
    raise exception 'SECURITY BUG: [34] authenticated has EXECUTE on get_hotel_whatsapp_connection_secret';
  end if;
  if has_function_privilege('anon', 'public.get_hotel_whatsapp_connection_secret(uuid, uuid)', 'EXECUTE') then
    raise exception 'SECURITY BUG: [35] anon has EXECUTE on get_hotel_whatsapp_connection_secret';
  end if;

  execute format('set local role authenticated');
  begin
    perform public.get_hotel_whatsapp_connection_secret(conn_id::uuid, hotel_a::uuid);
    raise exception 'SECURITY BUG: [34] authenticated was able to call get_hotel_whatsapp_connection_secret';
  exception
    when insufficient_privilege then
      raise notice 'OK: [34] authenticated rejected at the EXECUTE grant level';
  end;
  reset role;

  execute format('set local role anon');
  begin
    perform public.get_hotel_whatsapp_connection_secret(conn_id::uuid, hotel_a::uuid);
    raise exception 'SECURITY BUG: [35] anon was able to call get_hotel_whatsapp_connection_secret';
  exception
    when insufficient_privilege then
      raise notice 'OK: [35] anon rejected at the EXECUTE grant level';
  end;
  reset role;

  execute format('set local role service_role');
  select ciphertext into v_ciphertext from public.get_hotel_whatsapp_connection_secret(conn_id::uuid, hotel_a::uuid);
  reset role;
  if v_ciphertext is null then
    raise exception 'BUG: [33] service_role could not read the secret via get_hotel_whatsapp_connection_secret';
  end if;
  raise notice 'OK: [33] service_role can call get_hotel_whatsapp_connection_secret and receives crypto material';
end $$;

-- ================================================================
-- 36) get_hotel_whatsapp_connection_secret returns ONLY the documented
-- crypto/metadata columns — never a plaintext-shaped one.
-- ================================================================
do $$
declare
  v_columns text;
begin
  -- RETURNS TABLE columns are exposed as a composite result type via
  -- pg_get_function_result() — a single, reliable introspection call.
  select pg_get_function_result(p.oid) into v_columns
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_hotel_whatsapp_connection_secret';

  if v_columns is null then
    raise exception 'BUG: [36] get_hotel_whatsapp_connection_secret not found';
  end if;
  if v_columns !~* 'ciphertext' or v_columns !~* 'nonce' or v_columns !~* 'auth_tag' or v_columns !~* 'key_id' or v_columns !~* 'encryption_version' or v_columns !~* 'expires_at' then
    raise exception 'BUG: [36] get_hotel_whatsapp_connection_secret''s return shape is missing an expected column: %', v_columns;
  end if;
  if v_columns ~* 'plaintext|access_token|authorization_code|app_secret|decrypted' then
    raise exception 'SECURITY BUG: [36] get_hotel_whatsapp_connection_secret''s return shape references a plaintext-shaped column: %', v_columns;
  end if;
  raise notice 'OK: [36] get_hotel_whatsapp_connection_secret returns exactly the documented crypto/metadata columns (%)', v_columns;
end $$;

-- ================================================================
-- 37) No plaintext/token/secret parameter in either new function's own
-- pg_proc signature.
-- ================================================================
do $$
declare
  v_args_finalize text;
  v_args_get text;
begin
  select pg_get_function_arguments(p.oid) into v_args_finalize
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_hotel_whatsapp_connection_with_secret';

  select pg_get_function_arguments(p.oid) into v_args_get
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'get_hotel_whatsapp_connection_secret';

  if v_args_finalize ~* 'plaintext|access_token|authorization_code|app_secret|encryption_key|p_token\b' then
    raise exception 'SECURITY BUG: [37] finalize_hotel_whatsapp_connection_with_secret''s signature references a secret-shaped parameter: %', v_args_finalize;
  end if;
  if v_args_get ~* 'plaintext|access_token|authorization_code|app_secret|encryption_key|p_token\b' then
    raise exception 'SECURITY BUG: [37] get_hotel_whatsapp_connection_secret''s signature references a secret-shaped parameter: %', v_args_get;
  end if;
  raise notice 'OK: [37] no plaintext/token/secret-shaped parameter in either function''s own pg_proc signature';
end $$;

-- ================================================================
-- 38) No access_token/token/plaintext/secret_value COLUMN on
-- hotel_whatsapp_connection_secrets.
-- ================================================================
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'hotel_whatsapp_connection_secrets'
    and column_name in ('access_token', 'token', 'plaintext', 'secret_value', 'authorization_code', 'app_secret');
  if v_count <> 0 then
    raise exception 'SECURITY BUG: [38] a plaintext/token-shaped column exists on hotel_whatsapp_connection_secrets';
  end if;
  raise notice 'OK: [38] no access_token/token/plaintext/secret_value column exists on hotel_whatsapp_connection_secrets';
end $$;

rollback;
-- [39] rollback final — everything this script created is discarded here.
