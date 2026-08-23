-- =========================================================================
-- Proactif System — recommandation d'hébergement fondée sur la capacité.
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql / 0002_rag.sql / 0003_site_analysis_consent.sql.
--
-- PROPOSED, NOT YET APPLIED. Written for review; apply it through your own
-- Supabase workflow (dashboard SQL editor / `supabase db push`) when ready
-- — nothing in this codebase executes migrations automatically.
--
-- Neither table here is an audit log (unlike site_analysis_consents in
-- 0003) — ordinary content an admin can correct or delete, so there is no
-- immutability trigger and RLS uses FOR ALL rather than per-operation
-- policies.
-- =========================================================================

-- =========================================================================
-- accommodation_types
-- =========================================================================
-- A hotel's rooms/suites/apartments/studios — a real structured entity, not
-- a free-text label, because the assistant has to CHOOSE between several of
-- them based on group size (see src/features/rag/accommodationRanking.ts).
create table public.accommodation_types (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  name text not null,
  -- Page of the hotel's site this was detected on, if any.
  source_url text,
  -- Capacity is NEVER invented. NULL = unknown/not reliably determined —
  -- never forced to a guessed value. A row only ever gets a non-null
  -- max_guests/max_adults/max_children after a human has explicitly
  -- confirmed it in the crawler's curation UI; a value the crawler merely
  -- suggested from page text never reaches this table on its own. NULL must
  -- never be treated as "zero" or "unlimited" by any caller.
  max_guests integer,
  max_adults integer,
  max_children integer,
  bed_summary text,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accommodation_types_hotel_id_idx on public.accommodation_types (hotel_id);

-- Composite unique key, in addition to the plain `id` PK — exists purely so
-- room_photos (below) and any future table can FK on
-- (accommodation_type_id, hotel_id) together, making a cross-hotel
-- accommodation_type_id impossible to attach at the Postgres level, not
-- just by convention. See room_photos.accommodation_type_id below for the
-- FK that actually relies on this.
create unique index accommodation_types_id_hotel_id_key on public.accommodation_types (id, hotel_id);

alter table public.accommodation_types enable row level security;

create policy "superadmin full access" on public.accommodation_types
  for all using (public.is_superadmin()) with check (public.is_superadmin());

grant select, insert, update, delete on public.accommodation_types to authenticated;
revoke all on public.accommodation_types from anon;

-- =========================================================================
-- room_photos
-- =========================================================================
-- Linked to accommodation_types by a stable FK, never by a free-text room
-- name — renaming "Junior suite" to "Suite Junior" must never orphan its
-- photos. source_page_url (where the image was found) and source_image_url
-- (the image's own URL at the hotel) are kept distinct from storage_path/
-- photo_url (our own copy) so it's always possible to tell what was found
-- where versus what we actually host.
create table public.room_photos (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  -- Composite FK below (accommodation_type_id, hotel_id) instead of a plain
  -- accommodation_type_id -> accommodation_types(id) reference: a single-
  -- column FK would let a room_photos row with hotel_id=A reference an
  -- accommodation_type_id that actually belongs to hotel B — nothing at the
  -- Postgres level would catch that mismatch. The composite FK makes it
  -- impossible to insert such a row at all, not just discouraged by
  -- convention.
  accommodation_type_id uuid not null,
  source_page_url text,
  source_image_url text not null,
  storage_path text not null,
  photo_url text not null,
  -- SHA-256 of the actually-downloaded bytes — the real dedup key.
  -- source_image_url alone isn't enough: the same file can be reachable at
  -- two different URLs (e.g. after a site redesign), and this still catches
  -- that case. See safeFetchBinary in src/features/crawler/networkGuard.ts.
  content_hash text not null,
  alt_text text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  -- Tenant-safe: deleting an accommodation_type still cascades its photos
  -- (unchanged behavior), but only within the SAME hotel — the FK cannot be
  -- satisfied by an accommodation_type_id belonging to a different hotel_id.
  foreign key (accommodation_type_id, hotel_id) references public.accommodation_types (id, hotel_id) on delete cascade
);

-- One copy of a given image per hotel — a re-analysis of the same site (or
-- an admin re-selecting the same photo) is a silent no-op, never a
-- duplicate row. Scoped by hotel_id, not global, since two different hotels
-- coincidentally using the same stock photo is not a duplicate.
create unique index room_photos_hotel_content_hash_key on public.room_photos (hotel_id, content_hash);
create index room_photos_accommodation_type_idx on public.room_photos (accommodation_type_id);

alter table public.room_photos enable row level security;

create policy "superadmin full access" on public.room_photos
  for all using (public.is_superadmin()) with check (public.is_superadmin());

grant select, insert, update, delete on public.room_photos to authenticated;
revoke all on public.room_photos from anon;

-- =========================================================================
-- Storage — hotel-room-photos bucket, same public-read / superadmin-write
-- pattern already used for hotel-logos (0001_init.sql).
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('hotel-room-photos', 'hotel-room-photos', true)
on conflict (id) do nothing;

create policy "public read hotel-room-photos" on storage.objects
  for select
  using (bucket_id = 'hotel-room-photos');

create policy "superadmin manage hotel-room-photos" on storage.objects
  for all
  using (bucket_id = 'hotel-room-photos' and public.is_superadmin())
  with check (bucket_id = 'hotel-room-photos' and public.is_superadmin());
