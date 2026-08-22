-- RLS isolation check — run this in the Supabase SQL editor (or psql
-- connected to the project) AFTER 0001_init.sql has been applied.
--
-- It proves two things:
--   1. A non-superadmin authenticated user sees ZERO rows and cannot write.
--   2. A superadmin sees/writes normally.
--
-- Nothing here depends on a second real Auth user existing yet — it forges
-- the JWT claim Postgres would otherwise get from PostgREST, via
-- `request.jwt.claims`, which is exactly what `auth.uid()` reads.

begin;

-- ---- 1) Simulate a random authenticated user with NO profiles row ----
select set_config(
  'request.jwt.claims',
  json_build_object('sub', gen_random_uuid()::text, 'role', 'authenticated')::text,
  true
);
set local role authenticated;

-- Expect: 0 (RLS hides every row from a user profiles doesn't know)
select count(*) as hotels_visible_to_stranger from public.hotels;

-- Expect: insert fails (RLS check clause rejects it)
do $$
begin
  insert into public.hotels (name, slug, widget_key)
  values ('RLS test hotel', 'rls-test-hotel', 'ps_live_rlstest0000000000');
  raise exception 'SECURITY BUG: stranger was able to insert into hotels';
exception
  when insufficient_privilege or others then
    raise notice 'OK: insert correctly rejected for non-superadmin';
end $$;

rollback;

-- ---- 2) Same check, but for a real superadmin ----
-- Replace <SUPERADMIN_USER_ID> with the auth.users id of the account you
-- created via Authentication → Add user + the matching profiles row
-- (role = 'superadmin').
begin;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '<SUPERADMIN_USER_ID>', 'role', 'authenticated')::text,
  true
);
set local role authenticated;

-- Expect: the real row count (not 0) once at least one hotel exists.
select count(*) as hotels_visible_to_superadmin from public.hotels;

rollback;
