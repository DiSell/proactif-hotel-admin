-- Constraint/behavior checks for 0015_hotel_partners.sql — run this in the
-- Supabase SQL editor (or psql connected to the project) AFTER that
-- migration has been applied.
--
-- BEGIN/ROLLBACK, same style as every other test script in this project —
-- everything this script writes (including the auth.users fixture rows) is
-- rolled back at the end. No real project data is touched.
--
-- Simulating "logged in as user X" for a raw SQL RLS test uses the
-- standard PostgREST/Supabase mechanism: `auth.uid()` reads
-- `current_setting('request.jwt.claims', true)::json->>'sub'`, so setting
-- that GUC (plus `role = authenticated`) makes every subsequent statement
-- in this transaction behave exactly as if it came from that user's
-- session-bound client. See hotel_client_portal_check.sql for the same
-- pattern, established there.

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  partner_a uuid;
  partner_b uuid;
  partner_new uuid;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('HP Test Hotel A', 'hp-test-hotel-a', 'ps_live_hp_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('HP Test Hotel B', 'hp-test-hotel-b', 'ps_live_hp_test_b', 'active', true)
  returning id into hotel_b;

  insert into auth.users (id, email) values (user_a, 'hp-test-a@example.com');
  insert into auth.users (id, email) values (user_b, 'hp-test-b@example.com');

  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_a, 'hp-test-a@example.com', 'hotel_admin', 'Alice', 'A');
  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_b, 'hp-test-b@example.com', 'hotel_admin', 'Bob', 'B');

  insert into public.hotel_users (hotel_id, user_id) values (hotel_a, user_a);
  insert into public.hotel_users (hotel_id, user_id) values (hotel_b, user_b);

  insert into public.hotel_partners (hotel_id, name, category, priority)
  values (hotel_a, 'Restaurant du Centre', 'restaurant', 10)
  returning id into partner_a;

  insert into public.hotel_partners (hotel_id, name, category, priority)
  values (hotel_b, 'Taxi Dupont', 'transport', 5)
  returning id into partner_b;

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%, partner_a=%, partner_b=%)', hotel_a, hotel_b, partner_a, partner_b;

  -- ================================================================
  -- 1) category CHECK constraint
  -- ================================================================
  begin
    insert into public.hotel_partners (hotel_id, name, category) values (hotel_a, 'Invalide', 'not_a_real_category');
    raise exception 'BUG: an out-of-list category was accepted';
  exception
    when check_violation then
      raise notice 'OK: hotel_partners category CHECK rejects an unlisted category';
  end;

  -- ================================================================
  -- 2) name length constraint (empty name rejected)
  -- ================================================================
  begin
    insert into public.hotel_partners (hotel_id, name, category) values (hotel_a, '', 'other');
    raise exception 'BUG: an empty name was accepted';
  exception
    when check_violation then
      raise notice 'OK: hotel_partners_name_length rejects an empty name';
  end;

  -- ================================================================
  -- 3) description length constraint
  -- ================================================================
  begin
    insert into public.hotel_partners (hotel_id, name, category, description) values (hotel_a, 'Trop long', 'other', repeat('x', 2001));
    raise exception 'BUG: a 2001-char description was accepted';
  exception
    when check_violation then
      raise notice 'OK: hotel_partners_description_length rejects a 2001-char description';
  end;

  -- ================================================================
  -- Switch to "logged in as user_a" (hotel_admin of hotel_a) for the RLS checks
  -- ================================================================
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_a, 'role', 'authenticated')::text);

  -- 4) SELECT: hotel_admin A sees own partner, not hotel B's
  if not exists (select 1 from public.hotel_partners where id = partner_a) then
    raise exception 'BUG: hotel_admin A cannot read own hotel_partners row';
  end if;
  if exists (select 1 from public.hotel_partners where id = partner_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel B''s partner';
  end if;
  raise notice 'OK: SELECT isolated — hotel_admin A sees only hotel A''s partners';

  -- 5) INSERT: hotel_admin A can insert for hotel_a
  --
  -- A plain, top-level INSERT ... RETURNING id INTO a declared variable —
  -- never a WITH clause wrapping a data-modifying statement inside a
  -- subquery (e.g. `IF NOT EXISTS (WITH inserted AS (INSERT ... RETURNING
  -- id) SELECT 1 FROM inserted)`), which PostgreSQL rejects outright with
  -- "0A000: WITH clause containing a data-modifying statement must be at
  -- the top level" — a data-modifying CTE is only legal as the outermost
  -- WITH of its own standalone statement, never nested inside an EXISTS()/
  -- IF condition's argument. partner_new stays NULL only if this INSERT
  -- never assigned it — RLS rejecting the row raises an exception here
  -- (see check 6 below, which relies on exactly that), it does not silently
  -- return zero rows, so an unguarded INTO is safe — but the explicit
  -- IS NULL / row-existence checks below are kept anyway: "the statement
  -- didn't crash" is never treated as proof on its own.
  partner_new := null;
  insert into public.hotel_partners (hotel_id, name, category) values (hotel_a, 'Guide Local', 'guide') returning id into partner_new;
  if partner_new is null then
    raise exception 'BUG: hotel_admin A could not insert a partner for their own hotel (no id returned)';
  end if;
  if not exists (select 1 from public.hotel_partners where id = partner_new and hotel_id = hotel_a) then
    raise exception 'BUG: hotel_admin A''s insert for their own hotel did not actually persist a row';
  end if;
  raise notice 'OK: INSERT allowed for own hotel_id (partner_new=%)', partner_new;

  -- 6) INSERT: hotel_admin A CANNOT insert for hotel_b (WITH CHECK must reject it)
  begin
    insert into public.hotel_partners (hotel_id, name, category) values (hotel_b, 'Faux partenaire', 'other');
    raise exception 'SECURITY BUG: hotel_admin A was able to INSERT a partner for hotel B';
  exception
    when insufficient_privilege then
      raise notice 'OK: INSERT for hotel B rejected (insufficient_privilege, 42501 — RLS WITH CHECK)';
  end;

  -- 7) UPDATE: hotel_admin A can update own partner
  update public.hotel_partners set priority = 99 where id = partner_a;
  if (select priority from public.hotel_partners where id = partner_a) <> 99 then
    raise exception 'BUG: hotel_admin A could not update their own partner';
  end if;
  raise notice 'OK: UPDATE allowed for own hotel_id';

  -- 8) UPDATE: hotel_admin A cannot modify hotel B's partner — RLS USING
  -- means the row is simply invisible to the UPDATE, so it silently
  -- affects zero rows rather than erroring; verified explicitly below,
  -- never assumed.
  update public.hotel_partners set priority = 1234 where id = partner_b;
  if exists (select 1 from public.hotel_partners where id = partner_b) then
    raise exception 'BUG: test setup broken — partner_b should still be invisible to user_a for this check to be meaningful';
  end if;
  reset role;
  reset "request.jwt.claims";
  if (select priority from public.hotel_partners where id = partner_b) = 1234 then
    raise exception 'SECURITY BUG: hotel_admin A was able to UPDATE hotel B''s partner';
  end if;
  raise notice 'OK: UPDATE against hotel B''s partner affected zero rows — hotel B''s data unchanged';

  -- ================================================================
  -- Back to user_a for the DELETE checks
  -- ================================================================
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_a, 'role', 'authenticated')::text);

  -- 9) DELETE: hotel_admin A cannot delete hotel B's partner
  delete from public.hotel_partners where id = partner_b;
  reset role;
  reset "request.jwt.claims";
  if not exists (select 1 from public.hotel_partners where id = partner_b) then
    raise exception 'SECURITY BUG: hotel_admin A was able to DELETE hotel B''s partner';
  end if;
  raise notice 'OK: DELETE against hotel B''s partner affected zero rows — hotel B''s partner still exists';

  -- 10) DELETE: hotel_admin A can delete own partner
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_a, 'role', 'authenticated')::text);
  delete from public.hotel_partners where id = partner_a;
  reset role;
  reset "request.jwt.claims";
  if exists (select 1 from public.hotel_partners where id = partner_a) then
    raise exception 'BUG: hotel_admin A could not delete their own partner';
  end if;
  raise notice 'OK: DELETE allowed for own hotel_id';

  raise notice 'OK: all RLS CRUD checks passed';
end $$;

-- ================================================================
-- 11) anon: no privileges at all on hotel_partners
-- ================================================================
do $$
declare
  bad text := '';
begin
  if has_table_privilege('anon', 'public.hotel_partners', 'SELECT') then bad := bad || 'SELECT '; end if;
  if has_table_privilege('anon', 'public.hotel_partners', 'INSERT') then bad := bad || 'INSERT '; end if;
  if has_table_privilege('anon', 'public.hotel_partners', 'UPDATE') then bad := bad || 'UPDATE '; end if;
  if has_table_privilege('anon', 'public.hotel_partners', 'DELETE') then bad := bad || 'DELETE '; end if;

  if bad <> '' then
    raise exception 'SECURITY BUG: anon has unexpected privileges on hotel_partners: %', bad;
  end if;
  raise notice 'OK: anon has zero privileges on hotel_partners';
end $$;

-- ================================================================
-- 12) authenticated: broad grant present (RLS is the real gate — see 0004's
-- own documented pattern, reused here)
-- ================================================================
do $$
declare
  bad text := '';
begin
  if not has_table_privilege('authenticated', 'public.hotel_partners', 'SELECT') then bad := bad || 'missing SELECT '; end if;
  if not has_table_privilege('authenticated', 'public.hotel_partners', 'INSERT') then bad := bad || 'missing INSERT '; end if;
  if not has_table_privilege('authenticated', 'public.hotel_partners', 'UPDATE') then bad := bad || 'missing UPDATE '; end if;
  if not has_table_privilege('authenticated', 'public.hotel_partners', 'DELETE') then bad := bad || 'missing DELETE '; end if;

  if bad <> '' then
    raise exception 'BUG: unexpected authenticated privilege state on hotel_partners: %', bad;
  end if;
  raise notice 'OK: authenticated has select/insert/update/delete (RLS policies are the actual gate)';
end $$;

-- ================================================================
-- 13) service_role: SELECT only — never write access (the chatbot server
-- only reads active partners; all writes go through RLS via the
-- session-bound client, not service_role, for this table)
-- ================================================================
do $$
declare
  bad text := '';
begin
  if not has_table_privilege('service_role', 'public.hotel_partners', 'SELECT') then bad := bad || 'missing SELECT '; end if;
  if has_table_privilege('service_role', 'public.hotel_partners', 'INSERT') then bad := bad || 'unexpected INSERT '; end if;
  if has_table_privilege('service_role', 'public.hotel_partners', 'UPDATE') then bad := bad || 'unexpected UPDATE '; end if;
  if has_table_privilege('service_role', 'public.hotel_partners', 'DELETE') then bad := bad || 'unexpected DELETE '; end if;

  if bad <> '' then
    raise exception 'BUG: unexpected service_role privilege state on hotel_partners: %', bad;
  end if;
  raise notice 'OK: service_role has exactly SELECT on hotel_partners';
end $$;

-- ================================================================
-- 14) cascade delete: deleting a hotel deletes its partners too
-- ================================================================
do $$
declare
  hotel_c uuid;
  partner_c uuid;
begin
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('HP Test Hotel C', 'hp-test-hotel-c', 'ps_live_hp_test_c', 'active', true)
  returning id into hotel_c;

  insert into public.hotel_partners (hotel_id, name, category) values (hotel_c, 'À supprimer', 'other') returning id into partner_c;

  delete from public.hotels where id = hotel_c;

  if exists (select 1 from public.hotel_partners where id = partner_c) then
    raise exception 'BUG: hotel_partners row survived its hotel''s deletion — ON DELETE CASCADE not working as intended';
  end if;
  raise notice 'OK: deleting a hotel cascades to delete its hotel_partners rows';
end $$;

rollback;
