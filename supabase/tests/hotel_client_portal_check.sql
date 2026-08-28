-- Constraint/behavior checks for 0011_hotel_client_portal.sql — run this in
-- the Supabase SQL editor (or psql connected to the project) AFTER that
-- migration has been applied. Check #18's expected service_role grants on
-- hotel_users also assume 0012_hotel_client_access_management.sql has been
-- applied (it adds DELETE) — run this file after both, not after 0011 alone.
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
-- session-bound client.
--
-- Note: auth.users has many columns in a real Supabase project; this
-- script inserts only (id, email), which is sufficient on current Supabase
-- Postgres (other columns are nullable or defaulted). If your project's
-- auth.users has an additional NOT NULL column with no default, Postgres
-- will name it explicitly — add it to the two INSERTs below.

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  conv_a uuid;
  conv_b uuid;
  accommodation_a uuid;
  source_a uuid;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('HCP Test Hotel A', 'hcp-test-hotel-a', 'ps_live_hcp_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('HCP Test Hotel B', 'hcp-test-hotel-b', 'ps_live_hcp_test_b', 'active', true)
  returning id into hotel_b;

  insert into auth.users (id, email) values (user_a, 'hcp-test-a@example.com');
  insert into auth.users (id, email) values (user_b, 'hcp-test-b@example.com');

  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_a, 'hcp-test-a@example.com', 'hotel_admin', 'Alice', 'A');
  insert into public.profiles (id, email, role, first_name, last_name)
  values (user_b, 'hcp-test-b@example.com', 'hotel_admin', 'Bob', 'B');

  insert into public.hotel_users (hotel_id, user_id) values (hotel_a, user_a);
  insert into public.hotel_users (hotel_id, user_id) values (hotel_b, user_b);

  insert into public.chatbot_settings (hotel_id, welcome_message) values (hotel_a, 'Bonjour A');
  insert into public.chatbot_settings (hotel_id, welcome_message) values (hotel_b, 'Bonjour B');

  insert into public.widget_settings (hotel_id) values (hotel_a);
  insert into public.widget_settings (hotel_id) values (hotel_b);

  insert into public.accommodation_types (hotel_id, name) values (hotel_a, 'Suite A') returning id into accommodation_a;
  insert into public.accommodation_types (hotel_id, name) values (hotel_b, 'Suite B');

  insert into public.conversations (hotel_id, session_id) values (hotel_a, 'sess-a') returning id into conv_a;
  insert into public.conversations (hotel_id, session_id) values (hotel_b, 'sess-b') returning id into conv_b;

  insert into public.messages (hotel_id, conversation_id, role, content) values (hotel_a, conv_a, 'user', 'Bonjour A');
  insert into public.messages (hotel_id, conversation_id, role, content) values (hotel_b, conv_b, 'user', 'Bonjour B');

  insert into public.knowledge_sources (hotel_id, type, title, status, is_active)
  values (hotel_a, 'text', 'Source A', 'indexed', true)
  returning id into source_a;
  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_a, source_a, 'contenu confidentiel A', array_fill(0, array[1536])::vector, 0);

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%, user_a=%, user_b=%)', hotel_a, hotel_b, user_a, user_b;

  -- ================================================================
  -- 1) hotel_users unique(user_id) — a user cannot be linked to a second hotel
  -- ================================================================
  begin
    insert into public.hotel_users (hotel_id, user_id) values (hotel_b, user_a);
    raise exception 'BUG: user_a was linked to a second hotel — unique(user_id) not enforced';
  exception
    when unique_violation then
      raise notice 'OK: hotel_users_user_key rejects a second hotel for the same user_id';
  end;

  -- ================================================================
  -- 2) profiles length constraints
  -- ================================================================
  begin
    update public.profiles set first_name = repeat('x', 101) where id = user_a;
    raise exception 'BUG: first_name > 100 chars was accepted';
  exception
    when check_violation then
      raise notice 'OK: profiles_first_name_length rejects a 101-char first_name';
  end;
  begin
    update public.profiles set last_name = repeat('x', 101) where id = user_a;
    raise exception 'BUG: last_name > 100 chars was accepted';
  exception
    when check_violation then
      raise notice 'OK: profiles_last_name_length rejects a 101-char last_name';
  end;

  -- ================================================================
  -- Switch to "logged in as user_a" (hotel_admin of hotel_a) for the RLS checks
  -- ================================================================
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_a, 'role', 'authenticated')::text);

  -- 3) hotels: sees own, not the other
  if not exists (select 1 from public.hotels where id = hotel_a) then
    raise exception 'BUG: hotel_admin A cannot read own hotel';
  end if;
  if exists (select 1 from public.hotels where id = hotel_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel B';
  end if;
  raise notice 'OK: hotels — hotel_admin A sees only hotel A';

  -- 4) chatbot_settings
  if not exists (select 1 from public.chatbot_settings where hotel_id = hotel_a) then
    raise exception 'BUG: hotel_admin A cannot read own chatbot_settings';
  end if;
  if exists (select 1 from public.chatbot_settings where hotel_id = hotel_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel B chatbot_settings';
  end if;
  raise notice 'OK: chatbot_settings isolated';

  -- 5) widget_settings
  if not exists (select 1 from public.widget_settings where hotel_id = hotel_a) then
    raise exception 'BUG: hotel_admin A cannot read own widget_settings';
  end if;
  if exists (select 1 from public.widget_settings where hotel_id = hotel_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel B widget_settings';
  end if;
  raise notice 'OK: widget_settings isolated';

  -- 6) accommodation_types — NO policy at all for hotel_admin (removed from
  -- 0011 — no MVP portal page needs a direct browser-side read). Must be
  -- invisible even for hotel_admin A's OWN hotel's own accommodation_type.
  if exists (select 1 from public.accommodation_types where id = accommodation_a) then
    raise exception 'SECURITY BUG: hotel_admin A can read accommodation_types directly — this must go through service_role only (no policy should exist for this role)';
  end if;
  raise notice 'OK: accommodation_types is completely inaccessible to hotel_admin, even for their own hotel (no policy exists for this role)';

  -- 7) conversations
  if not exists (select 1 from public.conversations where id = conv_a) then
    raise exception 'BUG: hotel_admin A cannot read own conversation';
  end if;
  if exists (select 1 from public.conversations where id = conv_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel B conversation (even by known UUID)';
  end if;
  raise notice 'OK: conversations isolated — a known foreign conversation UUID is still invisible';

  -- 8) messages
  if not exists (select 1 from public.messages where conversation_id = conv_a) then
    raise exception 'BUG: hotel_admin A cannot read own messages';
  end if;
  if exists (select 1 from public.messages where conversation_id = conv_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel B messages';
  end if;
  raise notice 'OK: messages isolated';

  -- 9) knowledge_sources / knowledge_chunks — NO policy at all for hotel_admin,
  -- not even for their OWN hotel's data.
  if exists (select 1 from public.knowledge_sources where hotel_id = hotel_a) then
    raise exception 'SECURITY BUG: hotel_admin A can read knowledge_sources directly — this must go through service_role only';
  end if;
  if exists (select 1 from public.knowledge_chunks where hotel_id = hotel_a) then
    raise exception 'SECURITY BUG: hotel_admin A can read knowledge_chunks directly — this must go through service_role only';
  end if;
  raise notice 'OK: knowledge_sources/knowledge_chunks are completely inaccessible to hotel_admin, even for their own hotel';

  -- 10) message_sources — same reasoning, no policy exists for hotel_admin at all
  if exists (select 1 from public.message_sources where hotel_id = hotel_a) then
    raise exception 'SECURITY BUG: hotel_admin A can read message_sources directly';
  end if;
  raise notice 'OK: message_sources inaccessible to hotel_admin';

  -- 11) profiles — only own profile
  if not exists (select 1 from public.profiles where id = user_a) then
    raise exception 'BUG: hotel_admin A cannot read own profile';
  end if;
  if exists (select 1 from public.profiles where id = user_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel_admin B''s profile';
  end if;
  raise notice 'OK: profiles — only own row visible';

  -- 12) hotel_users — only own row
  if not exists (select 1 from public.hotel_users where user_id = user_a) then
    raise exception 'BUG: hotel_admin A cannot read own hotel_users row';
  end if;
  if exists (select 1 from public.hotel_users where user_id = user_b) then
    raise exception 'SECURITY BUG: hotel_admin A can read hotel_admin B''s hotel_users row';
  end if;
  raise notice 'OK: hotel_users — only own linking row visible';

  -- 13) hotel_users — hotel_admin cannot write (grant-level check, not just RLS)
  begin
    insert into public.hotel_users (hotel_id, user_id) values (hotel_a, gen_random_uuid());
    raise exception 'SECURITY BUG: hotel_admin A was able to INSERT into hotel_users — authenticated must be SELECT-only';
  exception
    when insufficient_privilege then
      raise notice 'OK: hotel_admin A cannot INSERT into hotel_users (insufficient_privilege, 42501)';
  end;

  reset role;
  reset "request.jwt.claims";

  -- ================================================================
  -- 14) is_hotel_admin_for as user_a: true for hotel_a, false for hotel_b
  -- ================================================================
  execute format('set local role authenticated');
  execute format('set local request.jwt.claims to %L', json_build_object('sub', user_a, 'role', 'authenticated')::text);
  if not public.is_hotel_admin_for(hotel_a) then
    raise exception 'BUG: is_hotel_admin_for(hotel_a) is false for user_a';
  end if;
  if public.is_hotel_admin_for(hotel_b) then
    raise exception 'SECURITY BUG: is_hotel_admin_for(hotel_b) is true for user_a';
  end if;
  raise notice 'OK: is_hotel_admin_for returns true only for the caller''s own hotel';
  reset role;
  reset "request.jwt.claims";
end $$;

-- ================================================================
-- 15) is_hotel_admin_for — SECURITY DEFINER / search_path / STABLE audit
-- ================================================================
do $$
declare
  is_definer boolean;
  is_stable boolean;
  configured_search_path text;
begin
  select p.prosecdef, (p.provolatile = 's'), (
    select cfg
    from unnest(p.proconfig) as cfg
    where cfg like 'search_path=%'
    limit 1
  )
  into is_definer, is_stable, configured_search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'is_hotel_admin_for';

  if not is_definer then
    raise exception 'SECURITY BUG: is_hotel_admin_for is not SECURITY DEFINER (prosecdef = false)';
  end if;
  if not is_stable then
    raise exception 'BUG: is_hotel_admin_for is not STABLE';
  end if;
  if configured_search_path is null or configured_search_path <> 'search_path=public' then
    raise exception 'SECURITY BUG: is_hotel_admin_for has no locked search_path=public (got %) — vulnerable to search_path hijacking', configured_search_path;
  end if;

  raise notice 'OK: is_hotel_admin_for is SECURITY DEFINER, STABLE, with search_path locked to public';
end $$;

-- ================================================================
-- 16) anon: no new access to any of these tables/objects
-- ================================================================
do $$
declare
  bad text := '';
begin
  if has_table_privilege('anon', 'public.hotel_users', 'SELECT') then bad := bad || 'hotel_users:SELECT '; end if;
  if has_table_privilege('anon', 'public.hotel_users', 'INSERT') then bad := bad || 'hotel_users:INSERT '; end if;
  if has_function_privilege('anon', 'public.is_hotel_admin_for(uuid)', 'EXECUTE') then bad := bad || 'is_hotel_admin_for:EXECUTE '; end if;
  if has_table_privilege('anon', 'public.profiles', 'SELECT') then bad := bad || 'profiles:SELECT(grant) '; end if;

  if bad <> '' then
    raise exception 'SECURITY BUG: anon gained unexpected privileges: %', bad;
  end if;
  raise notice 'OK: anon has no privileges on hotel_users, no EXECUTE on is_hotel_admin_for, no table-level grant on profiles';
end $$;

-- ================================================================
-- 17) authenticated: exactly SELECT on hotel_users — no INSERT/UPDATE/DELETE
-- ================================================================
do $$
declare
  bad text := '';
begin
  if not has_table_privilege('authenticated', 'public.hotel_users', 'SELECT') then bad := bad || 'hotel_users:missing SELECT '; end if;
  if has_table_privilege('authenticated', 'public.hotel_users', 'INSERT') then bad := bad || 'hotel_users:unexpected INSERT '; end if;
  if has_table_privilege('authenticated', 'public.hotel_users', 'UPDATE') then bad := bad || 'hotel_users:unexpected UPDATE '; end if;
  if has_table_privilege('authenticated', 'public.hotel_users', 'DELETE') then bad := bad || 'hotel_users:unexpected DELETE '; end if;
  if not has_function_privilege('authenticated', 'public.is_hotel_admin_for(uuid)', 'EXECUTE') then
    bad := bad || 'is_hotel_admin_for:missing EXECUTE ';
  end if;

  if bad <> '' then
    raise exception 'BUG: unexpected authenticated privilege state on hotel_users/is_hotel_admin_for: %', bad;
  end if;
  raise notice 'OK: authenticated has exactly SELECT on hotel_users (no INSERT/UPDATE/DELETE) and EXECUTE on is_hotel_admin_for';
end $$;

-- ================================================================
-- 18) service_role: exactly profiles(select,insert) / hotel_users(select,insert,delete) — nothing more
--
-- hotel_users DELETE was added by 0012_hotel_client_access_management.sql
-- for revokeHotelClientAccess (features/hotelUsers/actions.ts) — UPDATE is
-- still never granted (a link is created, deleted, or left alone, never
-- modified in place). Deleting a client's account entirely goes through
-- admin.auth.admin.deleteUser (the Auth Admin API, not a Data API write —
-- see 0012's own header comment), so it needs no grant here at all.
-- ================================================================
do $$
declare
  bad text := '';
begin
  if not has_table_privilege('service_role', 'public.profiles', 'SELECT') then bad := bad || 'profiles:missing SELECT '; end if;
  if not has_table_privilege('service_role', 'public.profiles', 'INSERT') then bad := bad || 'profiles:missing INSERT '; end if;
  if has_table_privilege('service_role', 'public.profiles', 'UPDATE') then bad := bad || 'profiles:unexpected UPDATE '; end if;
  if has_table_privilege('service_role', 'public.profiles', 'DELETE') then bad := bad || 'profiles:unexpected DELETE '; end if;

  if not has_table_privilege('service_role', 'public.hotel_users', 'SELECT') then bad := bad || 'hotel_users:missing SELECT '; end if;
  if not has_table_privilege('service_role', 'public.hotel_users', 'INSERT') then bad := bad || 'hotel_users:missing INSERT '; end if;
  if has_table_privilege('service_role', 'public.hotel_users', 'UPDATE') then bad := bad || 'hotel_users:unexpected UPDATE '; end if;
  if not has_table_privilege('service_role', 'public.hotel_users', 'DELETE') then bad := bad || 'hotel_users:missing DELETE '; end if;

  if bad <> '' then
    raise exception 'BUG: unexpected service_role privilege state: %', bad;
  end if;
  raise notice 'OK: service_role has exactly profiles(select,insert) and hotel_users(select,insert,delete)';
end $$;

rollback;
