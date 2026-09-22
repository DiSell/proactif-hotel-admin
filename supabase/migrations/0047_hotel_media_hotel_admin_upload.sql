-- Proactif System — hotel_admin upload capability for hotel_media, scoped
-- strictly to their own hotel_id, gated at the application layer by
-- hotels.photo_management = 'client' (see features/hotelMedia/actions.ts —
-- the mode check itself lives in application code, matching this project's
-- existing convention: hotels.photo_management has never been enforced
-- inside a raw SQL policy anywhere in this repo; only the hard tenant-
-- isolation boundary belongs at this layer, same reasoning already applied
-- everywhere else).
--
-- Additive only — 0046_hotel_media.sql (already applied in production) is
-- NEVER modified here. room_photos / accommodation_types, their own
-- policies, and photo_management's existing (unchanged) semantics for
-- room_photos are entirely untouched by this file.
--
-- PROPOSED, NOT YET APPLIED — nothing in this codebase executes migrations
-- automatically.

-- =========================================================================
-- try_cast_uuid — safe UUID parsing for an untrusted Storage object path
-- segment. A raw `::uuid` cast directly inside a policy expression would
-- raise a hard Postgres error (invalid_text_representation), not just
-- evaluate to false, for any malformed object name — and AND's lack of a
-- guaranteed left-to-right short-circuit/evaluation order in PostgreSQL
-- means a preceding regex check alone cannot safely guard that cast. This
-- function converts a cast failure into a clean NULL instead, so the
-- policy below can never error out on a malformed path — it just correctly
-- denies it. Pure computation only (no table/session access), hence
-- IMMUTABLE; SECURITY INVOKER (default) is correct here — no privilege
-- elevation is needed or wanted for a plain string-parsing helper.
-- =========================================================================
create or replace function public.try_cast_uuid(value text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return value::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;

revoke all on function public.try_cast_uuid(text) from public, anon;
grant execute on function public.try_cast_uuid(text) to authenticated;

-- =========================================================================
-- service_role: INSERT only, added to hotel_media (0046 already granted
-- SELECT + UPDATE for the existing is_selected toggle path). The
-- client-scoped Server Action (addHotelMediaPhotoClient) authorizes via
-- requireHotelAccess + a fresh hotels.photo_management read BEFORE ever
-- reaching this grant's privilege — exactly the same discipline already
-- used by setHotelMediaSelectionInternal for UPDATE. RLS on the table
-- itself stays superadmin-only (0046, untouched) — service_role is the
-- only additional writer, and only for INSERT; no UPDATE/DELETE added
-- here, nothing broader than what this phase's flow actually needs.
-- =========================================================================
grant insert on public.hotel_media to service_role;

-- =========================================================================
-- Storage — hotel_admin may INSERT into the hotel-media bucket, but ONLY
-- under a path whose first folder segment is a hotel_id they are actually
-- linked to (public.is_hotel_admin_for — the same helper already used
-- everywhere else in this project for this exact check). The existing
-- "superadmin manage hotel-media" policy (0046) is untouched and still
-- grants superadmin unconditional full access regardless of this new
-- policy. No UPDATE/DELETE granted here — not needed by the upload flow
-- (every upload is a brand new object; there is no in-place replace or
-- removal UI for hotel_media in this phase).
-- =========================================================================
create policy "hotel_admin upload own hotel-media" on storage.objects
  for insert
  with check (
    bucket_id = 'hotel-media'
    and public.try_cast_uuid((storage.foldername(name))[1]) is not null
    and public.is_hotel_admin_for(public.try_cast_uuid((storage.foldername(name))[1]))
  );
