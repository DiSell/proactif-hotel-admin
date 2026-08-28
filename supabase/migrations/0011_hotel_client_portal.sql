-- =========================================================================
-- Proactif System — hotel client portal (MVP): hotel_admin role activation.
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql through 0010_host_booking_action.sql (both
-- already applied/validated; neither is touched here, only built on top
-- of).
--
-- PROPOSED, NOT YET APPLIED. Apply it through your own Supabase workflow
-- (dashboard SQL editor / `supabase db push`) when ready — nothing in this
-- codebase executes migrations automatically. No auth.users row, no
-- profiles row, no hotel_users row is created by this migration — it only
-- creates the schema/policies a real invitation (features/hotelUsers/
-- actions.ts) writes into.
--
-- Context: `profiles.role` has accepted 'hotel_admin' since 0001_init.sql
-- (never used until now) — this migration activates it: a table linking a
-- hotel_admin user to exactly one hotel, a SECURITY DEFINER helper that
-- embeds BOTH "is this the right role" and "is this the right hotel" in
-- one place, and read-only RLS policies scoped by it.
--
-- Applied via the Supabase SQL Editor, public.is_hotel_admin_for(uuid)
-- below will be OWNED by whichever role the SQL Editor session runs as —
-- typically `postgres` (Supabase's own project-admin role), same as every
-- other function already defined by 0001_init.sql/0002_rag.sql
-- (is_superadmin(), match_knowledge_chunks(), replace_knowledge_chunks()).
-- That role already has full read access to public.hotel_users/
-- public.profiles regardless — is_superadmin() is live proof this exact
-- pattern already works correctly in this project today. The owner is
-- deliberately NOT changed explicitly by this migration.
-- =========================================================================

-- =========================================================================
-- profiles — name fields, needed for the invitation form and the client
-- Account page. Nullable: existing superadmin rows are never backfilled.
-- Length-bounded the same way the Zod schema (features/hotelUsers/
-- actions.ts's inviteSchema) already is — defense in depth, not the
-- primary check.
-- =========================================================================
alter table public.profiles
  add column first_name text,
  add column last_name text,
  add constraint profiles_first_name_length check (first_name is null or char_length(first_name) <= 100),
  add constraint profiles_last_name_length check (last_name is null or char_length(last_name) <= 100);

-- =========================================================================
-- hotel_users — the ONLY place a user is linked to a hotel.
-- =========================================================================
-- MVP: one hotel per client account, enforced at the database level, not
-- just by application convention. `hotel_users_hotel_user_key` alone would
-- allow a hotel to have several users (intentional — future multi-staff
-- support needs no schema change) but would NOT stop a single user_id from
-- being linked to several hotels; `hotel_users_user_key` is what actually
-- forces "at most one hotel per user" — requireClientAccess() (see
-- src/lib/auth/session.ts) can therefore expect exactly zero or one row,
-- never "the first hotel found among several".
create table public.hotel_users (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint hotel_users_hotel_user_key unique (hotel_id, user_id),
  constraint hotel_users_user_key unique (user_id)
);

create index hotel_users_hotel_id_idx on public.hotel_users (hotel_id);

alter table public.hotel_users enable row level security;

-- Matches the "superadmin full access" shape used on every other business
-- table in this project (for consistency, and so a future admin-side
-- write feature — e.g. "revoke a client's access" — needs only a GRANT
-- added here later, no new policy). It is currently INERT for
-- insert/update/delete: GRANT is checked before RLS, and `authenticated`
-- below is granted SELECT only. No code path in this codebase writes to
-- hotel_users via the session-bound client today — every write (the
-- invitation Server Action) goes through service_role instead.
create policy "superadmin full access" on public.hotel_users
  for all using (public.is_superadmin()) with check (public.is_superadmin());

-- A user can see their own single linking row (used by requireClientAccess
-- to resolve which hotel they belong to) — never anyone else's.
create policy "user can read own hotel_users row" on public.hotel_users
  for select using (user_id = auth.uid());

-- =========================================================================
-- Data API grants — least privilege, same discipline as every migration
-- since 0006. No GRANT ALL, no ALTER DEFAULT PRIVILEGES.
-- =========================================================================
-- authenticated: SELECT only. No MVP feature modifies or deletes a
-- hotel_users row via the session-bound client — the invitation Server
-- Action writes exclusively through service_role (below). A future
-- "manage client access" admin feature adds INSERT/UPDATE/DELETE here
-- explicitly, when it actually exists, not ahead of it.
grant select on public.hotel_users to authenticated;
revoke all on public.hotel_users from anon;

-- service_role (the invitation Server Action, features/hotelUsers/actions.ts):
-- exactly the two operations that action performs — see its own comments
-- for the operation-by-operation justification. SELECT to check for an
-- existing link before writing (idempotency / conflict detection —
-- CAS B/C in the plan), INSERT to create a new one. Never UPDATE (a link
-- is never modified, only created or left alone) or DELETE.
grant select, insert on public.hotel_users to service_role;

-- service_role also needs profiles access for the same action: SELECT to
-- read back an existing user's role (CAS D — never silently convert a
-- superadmin) and to check for an existing profile before inserting;
-- INSERT (via ON CONFLICT DO NOTHING) to create a new hotel_admin profile.
-- Never granted before this migration (0009 explicitly excluded profiles).
grant select, insert on public.profiles to service_role;

-- =========================================================================
-- is_hotel_admin_for — the ONLY place hotel_admin authorization is decided
-- at the database level. Deliberately a single helper embedding BOTH
-- required conditions (role AND hotel_users membership) so no individual
-- policy can accidentally grant access checking only one of the two.
--
-- SECURITY DEFINER (runs as its owner, not the caller — never blocked by
-- the RLS it's evaluating, same reasoning as is_superadmin() in
-- 0001_init.sql). SET search_path = public (explicit and fixed, prevents
-- a search_path-shadowing hijack). Both referenced tables fully qualified
-- (public.hotel_users, public.profiles), auth.uid() fully qualified
-- (schema `auth`). No dynamic SQL anywhere in the body. STABLE (a pure
-- read within one statement, safe for the planner to cache per-statement).
-- =========================================================================
create or replace function public.is_hotel_admin_for(p_hotel_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.hotel_users hu
    join public.profiles p on p.id = hu.user_id
    where hu.user_id = auth.uid()
      and hu.hotel_id = p_hotel_id
      and p.role = 'hotel_admin'
  );
$$;

-- Locked down exactly like is_superadmin() (0001_init.sql): no PUBLIC
-- execute, only the one role whose RLS policies actually call it.
-- service_role never needs this — it bypasses RLS entirely.
revoke all on function public.is_hotel_admin_for(uuid) from public;
grant execute on function public.is_hotel_admin_for(uuid) to authenticated;

-- =========================================================================
-- hotel_admin read-only policies — additive, alongside the existing
-- "superadmin full access" policy on each table (never replaced, never
-- weakened). SELECT only: the client portal's own writes (the chat-test
-- route) go through service_role after server-side authorization, not
-- through these policies — see requireHotelAccess() /
-- src/app/api/hotels/[id]/chat/route.ts.
--
-- Deliberately NO policy at all on:
--   - knowledge_sources / knowledge_chunks / message_sources — the RAG
--     internals, never queried directly by the hotel_admin browser
--     session (the chat-test route uses service_role for that).
--   - accommodation_types — audited: no MVP portal page performs a direct
--     browser-side SELECT on it. The chat test (which DOES need
--     accommodation_types internally, for room ranking) also runs through
--     service_role, which already holds this grant from 0009. A policy is
--     added here explicitly, in a future migration, the day a real
--     portal feature needs a direct read — not ahead of that need.
-- =========================================================================
create policy "hotel_admin can read own hotel" on public.hotels
  for select using (public.is_hotel_admin_for(id));

create policy "hotel_admin can read own chatbot_settings" on public.chatbot_settings
  for select using (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can read own widget_settings" on public.widget_settings
  for select using (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can read own conversations" on public.conversations
  for select using (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can read own messages" on public.messages
  for select using (public.is_hotel_admin_for(hotel_id));

-- No new GRANTs needed on hotels/chatbot_settings/widget_settings/
-- conversations/messages — `authenticated` already has full table-level
-- grants on all of them from 0001/0002. GRANT and POLICY are orthogonal
-- (documented in 0001_init.sql's own header): only the policy was missing
-- for this role, not the grant.
