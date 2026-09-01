-- =========================================================================
-- Proactif System — "Événements / Informations" : faits propres à un hôtel
-- que le chatbot doit connaître et utiliser dans ses réponses, curatés par
-- l'établissement lui-même (jamais inventés par le chatbot).
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql through 0031_hotel_whatsapp_activation_tokens_revoke_service_role_references.sql.
--
-- PROPOSED, NOT YET APPLIED. Apply it through your own Supabase workflow
-- (dashboard SQL editor / `supabase db push`) when ready — nothing in this
-- codebase executes migrations automatically.
--
-- Product intent (see features/events/, features/rag/events.ts):
--   - Two kinds, distinguished by `type`:
--     - 'permanent': no expiry concept — starts_at/ends_at always null.
--     - 'temporary': starts_at/ends_at both required, ends_at >= starts_at.
--   - Deliberately mirrors hotel_partners (0015_hotel_partners.sql)'s own
--     shape and RLS/grant discipline exactly: a small, low-risk, per-hotel
--     CRUD resource, curated directly by the hotel_admin through the
--     session-bound client (RLS is the real gate for writes here, same as
--     hotel_partners — not service_role, unlike the more sensitive
--     WhatsApp/photo-selection write paths).
--   - `starts_at`/`ends_at` are plain `date` (no time-of-day) — this MVP
--     deliberately does not introduce a time-of-day concept nowhere else in
--     this codebase's admin/client UI has one yet.
--   - show_as_banner is a narrower, OPTIONAL flag on top of a 'temporary'
--     event — see the CHECK constraint below forbidding it on 'permanent'
--     rows (a banner needs a period to eventually disappear after).
-- =========================================================================

create table public.hotel_events (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  type text not null check (type in ('permanent', 'temporary')),
  title text not null,
  content text not null,
  starts_at date,
  ends_at date,
  is_active boolean not null default true,
  show_as_banner boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_events_title_length check (char_length(title) between 1 and 200),
  constraint hotel_events_content_length check (char_length(content) between 1 and 2000),
  -- A 'temporary' event must have both dates, consistently ordered; a
  -- 'permanent' event must have neither — never a half-filled row of either
  -- kind.
  constraint hotel_events_temporary_dates check (
    (type = 'temporary' and starts_at is not null and ends_at is not null and ends_at >= starts_at)
    or (type = 'permanent' and starts_at is null and ends_at is null)
  ),
  -- A permanent fact has no period to stop displaying a banner after — the
  -- application layer (features/events/schema.ts) also rejects this
  -- combination before it ever reaches the database, this is the
  -- structural backstop.
  constraint hotel_events_banner_requires_temporary check (not show_as_banner or type = 'temporary')
);

-- Serves both real read patterns: the management list (all events for a
-- hotel, features/events/queries.ts) and the chatbot's own active-events
-- query (features/rag/events.ts:loadActiveHotelEvents, filtered further by
-- type/ends_at at query time — a single hotel's event count is small enough
-- that no more specific partial index is warranted at this stage).
create index hotel_events_hotel_active_idx on public.hotel_events (hotel_id, is_active);

alter table public.hotel_events enable row level security;

-- Reuses the existing trigger function from 0001_init.sql — no new function
-- needed, same pattern already used for hotels/chatbot_settings/
-- widget_settings/hotel_partners.
create trigger set_updated_at before update on public.hotel_events
  for each row execute function public.set_updated_at();

-- =========================================================================
-- RLS — identical shape to 0015_hotel_partners.sql: full CRUD for
-- hotel_admin through the session-bound client (RLS is the real gate),
-- full access for superadmin, nothing at all for anon.
-- =========================================================================
create policy "superadmin full access" on public.hotel_events
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "hotel_admin can select own hotel_events" on public.hotel_events
  for select using (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can insert own hotel_events" on public.hotel_events
  for insert with check (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can update own hotel_events" on public.hotel_events
  for update using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can delete own hotel_events" on public.hotel_events
  for delete using (public.is_hotel_admin_for(hotel_id));

-- =========================================================================
-- Data API grants — least privilege, RLS is the real gate for
-- `authenticated` (same discipline as hotel_partners: GRANT and POLICY are
-- orthogonal, the policies above are what actually restrict rows).
-- service_role: SELECT only — the chatbot server (features/rag/events.ts,
-- called from answerQuestion, and the public widget's config route for the
-- banner) reads events for an already-resolved hotelId; it never writes
-- here (client/superadmin writes go through RLS, not service_role, for
-- this table — same as hotel_partners).
-- =========================================================================
grant select, insert, update, delete on public.hotel_events to authenticated;
grant select on public.hotel_events to service_role;
revoke all on public.hotel_events from anon;
