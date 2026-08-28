-- =========================================================================
-- Proactif System — "Partenaires recommandés par l'hôtel".
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql through 0014_chatbot_personalization.sql.
--
-- PROPOSED, NOT YET APPLIED. Apply it through your own Supabase workflow
-- (dashboard SQL editor / `supabase db push`) when ready — nothing in this
-- codebase executes migrations automatically.
--
-- Product intent (see features/partners/, features/rag/partners.ts):
--   - Each hotel curates its own list of local partners (restaurant, taxi,
--     activity, bike rental, guide, shop, local product, wellness, other).
--     The partner is chosen and validated by the hotel — the chatbot never
--     invents one, it only ever recommends rows that exist here, scoped to
--     the visitor's own hotel_id, filtered to is_active, ranked by
--     priority DESC then name ASC, capped server-side (see
--     features/rag/partners.ts).
--   - Independent of accommodation_types/room_photos/knowledge_sources —
--     a partner is never a "fake accommodation" and never enters the RAG
--     knowledge base. See point 11 of the product spec this migration
--     implements.
--   - `category` is a plain `text` + CHECK constraint, not a Postgres enum:
--     this repo already uses that exact pattern for a similarly-small,
--     still-evolving closed set (hotels.photo_management, 0014's
--     'client'/'proactif' check) — a CHECK constraint is one `alter table
--     ... drop constraint / add constraint` away from adding a category,
--     whereas a Postgres enum type requires ALTER TYPE ADD VALUE (which
--     itself can't run inside the same transaction as code that uses the
--     new value) and is more painful to shrink. Validated against this
--     repo's own conventions before implementation, as requested.
-- =========================================================================

create table public.hotel_partners (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  name text not null,
  category text not null check (
    category in ('restaurant', 'transport', 'activity', 'wellness', 'shopping', 'local_product', 'guide', 'rental', 'other')
  ),
  description text,
  address text,
  phone text,
  website_url text,
  booking_url text,
  is_active boolean not null default true,
  priority integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_partners_name_length check (char_length(name) between 1 and 200),
  constraint hotel_partners_description_length check (description is null or char_length(description) <= 2000)
);

-- The chatbot's own read pattern (features/rag/partners.ts:loadPartnerCandidates):
-- .eq("hotel_id", hotelId).eq("is_active", true).order("priority", { ascending: false }).order("name") —
-- this index serves that query directly. The client/superadmin portal list
-- (all partners, active or not) is a small per-hotel table scan, no
-- dedicated index needed for it.
create index hotel_partners_hotel_active_priority_idx
  on public.hotel_partners (hotel_id, is_active, priority desc, name);

alter table public.hotel_partners enable row level security;

-- Reuses the existing trigger function from 0001_init.sql — no new
-- function needed, same pattern already used for hotels/chatbot_settings/
-- widget_settings/knowledge_sources.
create trigger set_updated_at before update on public.hotel_partners
  for each row execute function public.set_updated_at();

-- =========================================================================
-- RLS — matches the established "superadmin full access" + scoped
-- hotel_admin policies shape (0011_hotel_client_portal.sql), extended here
-- to full CRUD for hotel_admin (not read-only) since the client portal
-- writes hotel_partners directly through the session-bound client, RLS as
-- the real gate — deliberately different from 0014's photo-selection
-- actions (which write via service_role after an app-level check): a
-- partner is a small, low-risk CRUD resource with no external side effect
-- (no storage upload, no third-party fetch), so there is no reason to
-- route it through service_role instead of RLS.
-- =========================================================================
create policy "superadmin full access" on public.hotel_partners
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "hotel_admin can select own hotel_partners" on public.hotel_partners
  for select using (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can insert own hotel_partners" on public.hotel_partners
  for insert with check (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can update own hotel_partners" on public.hotel_partners
  for update using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can delete own hotel_partners" on public.hotel_partners
  for delete using (public.is_hotel_admin_for(hotel_id));

-- No policy at all for `anon` — RLS defaults to deny, and the explicit
-- `revoke all ... from anon` below removes even the possibility of a GRANT
-- ever making a policy-less anon read succeed by accident.

-- =========================================================================
-- Data API grants — least privilege, RLS is the real gate for
-- authenticated (broad grant, same discipline as accommodation_types/
-- room_photos in 0004_accommodation_types.sql: "GRANT and POLICY are
-- orthogonal", the policies above are what actually restrict rows).
-- service_role: SELECT only — the chatbot server (features/rag/partners.ts,
-- called from answerQuestion) reads active partners for a resolved
-- hotel_id; it never writes here (client/superadmin writes go through RLS,
-- not service_role, for this table — see the RLS section above). No
-- broad GRANT ALL anywhere in this migration.
-- =========================================================================
grant select, insert, update, delete on public.hotel_partners to authenticated;
grant select on public.hotel_partners to service_role;
revoke all on public.hotel_partners from anon;

-- =========================================================================
-- Future inter-chatbot network (NOT implemented here — see product spec
-- point 12 and the final report): no speculative column is added by this
-- migration. When that feature is actually built, the natural extension is
-- an ADDITIVE migration introducing something like
-- `linked_hotel_id uuid references public.hotels(id)` and/or a separate
-- `partner_organizations`/`partner_links` table — never a retrofit of this
-- table's existing columns, and never added ahead of the actual need.
-- =========================================================================
