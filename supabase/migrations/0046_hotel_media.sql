-- Proactif System — Phase 1 "photos générales de l'hôtel" (hors hébergements).
--
-- Additive only — no change to any existing table, column, function, policy,
-- or bucket. room_photos / accommodation_types (0004_accommodation_types.sql)
-- and the 58 validated accommodation photos are entirely untouched.
--
-- Generic categories, not specific to any one hotel — same discipline as
-- HOTEL_PARTNER_CATEGORIES (features/partners/schema.ts): a fixed, small,
-- multilingual-agnostic vocabulary, never a free-text field, so the future
-- chatbot-facing read (Phase 2, NOT built here) can reason about "the pool
-- photos" the same way for every hotel.
--
-- Deliberately NOT linked to accommodation_types in any way — these are
-- photos of the ESTABLISHMENT, not of a specific room/suite. See
-- features/rag/roomPhotos.ts's own loadSelectedRoomPhotos, unchanged, which
-- remains the only photo path the chatbot actually uses today.
--
-- PROPOSED, NOT YET APPLIED — nothing in this codebase executes migrations
-- automatically.

create table public.hotel_media (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  category text not null check (category in (
    'pool', 'spa', 'sauna', 'hammam', 'jacuzzi', 'fitness', 'exterior', 'breakfast',
    'restaurant', 'seminar', 'wedding', 'chapel', 'facade', 'common_area', 'parking', 'other'
  )),
  title text,
  -- Kept for parity with room_photos and a possible future crawler-driven
  -- import path — never populated by the Phase 1 manual-upload UI below,
  -- which always leaves both null (the photo comes from the admin's own
  -- file, not a page it was found on).
  source_page_url text,
  source_image_url text,
  storage_path text not null,
  photo_url text not null,
  -- SHA-256 of the uploaded file's own bytes, computed client-side (Web
  -- Crypto SubtleCrypto — no new dependency) before upload, since this
  -- Phase 1 flow uploads a browser File directly rather than fetching a
  -- remote URL server-side (unlike room_photos' safeFetchBinary path) —
  -- same dedup guarantee (one copy of a given image per hotel), different
  -- mechanism to get there.
  content_hash text not null,
  alt_text text,
  position integer not null default 0,
  is_selected boolean not null default true,
  created_at timestamptz not null default now(),
  constraint hotel_media_hotel_content_hash_key unique (hotel_id, content_hash)
);

create index hotel_media_hotel_category_idx on public.hotel_media (hotel_id, category, position);

alter table public.hotel_media enable row level security;

-- Same shape as accommodation_types/room_photos (0004) + their later
-- hotel_admin read policy (0014_chatbot_personalization.sql): superadmin
-- has full access; hotel_admin can only ever read their own hotel's rows.
-- Writes for hotel_admin go through the service_role-bound Server Action
-- (features/hotelMedia/actions.ts), authorized by requireHotelAccess
-- beforehand — same discipline as setPhotoSelectionInternal in
-- features/photos/actions.ts, RLS is not the write gate on that path.
create policy "superadmin full access to hotel_media" on public.hotel_media
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "hotel_admin can read own hotel_media" on public.hotel_media
  for select using (public.is_hotel_admin_for(hotel_id));

grant select, insert, update, delete on public.hotel_media to authenticated;
revoke all on public.hotel_media from anon;

-- service_role: SELECT + UPDATE only, matching room_photos' own precedent
-- (0014) exactly — the is_selected toggle action (both scopes) reads and
-- updates via service_role after requireHotelAccess; INSERT always goes
-- through the superadmin-only upload action's session-bound client instead
-- (relying on the "superadmin full access" policy above), so no
-- service_role INSERT/DELETE is granted — nothing broader than what's
-- actually used, same reasoning already documented in 0014.
grant select, update on public.hotel_media to service_role;

-- =========================================================================
-- Storage — hotel-media bucket, identical public-read / superadmin-write
-- pattern already used for hotel-room-photos (0004) and hotel-logos (0001).
-- Path convention: {hotel_id}/{uuid}.{ext} — same as room_photos' own
-- storagePath, so a future shared helper could target either bucket the
-- same way if ever needed (not done here).
-- =========================================================================
insert into storage.buckets (id, name, public)
values ('hotel-media', 'hotel-media', true)
on conflict (id) do nothing;

create policy "public read hotel-media" on storage.objects
  for select
  using (bucket_id = 'hotel-media');

create policy "superadmin manage hotel-media" on storage.objects
  for all
  using (bucket_id = 'hotel-media' and public.is_superadmin())
  with check (bucket_id = 'hotel-media' and public.is_superadmin());
