-- =========================================================================
-- Proactif System — chatbot personalization: photo selection + who manages
-- it, assistant name/welcome message reuse existing columns (no new column
-- needed for those two).
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql through 0013_hybrid_retrieval.sql.
--
-- PROPOSED, NOT YET APPLIED. Apply it through your own Supabase workflow
-- (dashboard SQL editor / `supabase db push`) when ready — nothing in this
-- codebase executes migrations automatically.
--
-- Context / product decision (see features/knowledge/accommodationGrouping.ts,
-- features/photos/, features/client/):
--   - "Proactif détecte et prépare automatiquement. Le client hôtel garde
--     le dernier mot sur ce qui apparaît dans son chatbot." Every distinct
--     photo detected for an accommodation is now saved to room_photos
--     (never capped, never pre-chosen by Proactif) — is_selected is the
--     new, separate flag deciding whether a given photo is actually shown.
--   - hotels.photo_management records WHO controls that flag day to day:
--     'client' (default — the hotel's own admin) or 'proactif' (delegated
--     to the superadmin back-office). The client is the only one who can
--     change this setting — see features/client/actions.ts:setPhotoManagementMode.
--   - assistant_name (hotels) and the widget's own welcome_message
--     (widget_settings — the field src/features/widget/publicHotel.ts's
--     resolvePublicWidgetContext actually reads for the live public
--     widget) are REUSED as-is for the client-editable "Nom de l'assistant"
--     / "Message d'accueil" fields — no new column for either. See this
--     migration's own comment below on chatbot_settings.welcome_message for
--     why that field, despite existing, is NOT the one reused.
-- =========================================================================

-- =========================================================================
-- hotels.photo_management — see features/client/actions.ts:setPhotoManagementMode.
-- Defaults to 'client': existing hotels are NOT silently switched to
-- Proactif-managed photos by this migration — the client keeps the final
-- word unless they explicitly delegate it.
-- =========================================================================
alter table public.hotels
  add column photo_management text not null default 'client'
    check (photo_management in ('client', 'proactif'));

-- =========================================================================
-- room_photos.is_selected — see features/photos/actions.ts. Defaults to
-- true so every room_photos row that already exists (saved before this
-- column existed) keeps being shown exactly as before — this migration
-- never silently hides a photo that was already live.
-- =========================================================================
alter table public.room_photos
  add column is_selected boolean not null default true;

-- =========================================================================
-- hotel_admin read-only policies on accommodation_types / room_photos —
-- additive, alongside the existing "superadmin full access" policy on each
-- table (0004_accommodation_types.sql; never replaced, never weakened).
-- 0011_hotel_client_portal.sql deliberately left these two tables without a
-- hotel_admin policy ("no MVP portal page performs a direct browser-side
-- SELECT on it") — that need now exists (the /client/photos page), so the
-- policy is added here, not ahead of it, per that migration's own stated
-- plan. Uses the same public.is_hotel_admin_for(uuid) helper defined there
-- — no new helper function needed.
--
-- SELECT only: writes from the client portal (toggling is_selected) go
-- through a Server Action guarded by requireHotelAccess()/
-- requireClientAccess() using the service_role client, same discipline as
-- every other client-portal write in this codebase (see
-- features/hotelUsers/actions.ts, features/photos/actions.ts) — RLS is not
-- the gate for those writes, the prior server-side authorization check is.
-- =========================================================================
create policy "hotel_admin can read own accommodation_types" on public.accommodation_types
  for select using (public.is_hotel_admin_for(hotel_id));

create policy "hotel_admin can read own room_photos" on public.room_photos
  for select using (public.is_hotel_admin_for(hotel_id));

-- No new GRANT needed for `authenticated` on either table — 0004 already
-- grants it select/insert/update/delete on both. GRANT and POLICY are
-- orthogonal (see 0011's own header): only the policy was missing.

-- =========================================================================
-- service_role — additive grants for the new photo-selection and
-- chatbot-personalization Server Actions (features/photos/actions.ts,
-- features/client/actions.ts). 0009_widget_service_role_permissions.sql
-- granted service_role SELECT only on hotels/widget_settings/room_photos
-- (for the public widget's read path) — none of UPDATE/INSERT, since no
-- service_role write existed yet. Exactly the operations the new actions
-- perform, nothing broader:
--   - hotels: UPDATE, for assistant_name (setPhotoManagementMode also
--     writes photo_management on the same table/row).
--   - widget_settings: INSERT + UPDATE, to upsert welcome_message — a
--     hotel with no widget_settings row yet (never visited the widget
--     settings page) needs one created, same as saveWidgetSettings'
--     own upsert (features/widget/actions.ts).
--   - room_photos: UPDATE, for is_selected only in practice (the action
--     never touches any other column) — column-level grants aren't used
--     elsewhere in this project, so table-level UPDATE matches the
--     existing pattern rather than introducing a new one.
-- =========================================================================
grant update on public.hotels to service_role;
grant insert, update on public.widget_settings to service_role;
grant update on public.room_photos to service_role;

-- =========================================================================
-- Why NOT chatbot_settings.welcome_message:
--
-- Two separate "welcome message" columns already existed before this
-- migration: chatbot_settings.welcome_message (edited today by the
-- superadmin's Assistant page, features/assistant/) and
-- widget_settings.welcome_message (edited today by the superadmin's Widget
-- page, WidgetSettingsForm.tsx). Auditing src/features/widget/publicHotel.ts
-- (resolvePublicWidgetContext -> buildPublicWidgetConfig) shows the REAL
-- public widget's displayed welcome message is built exclusively from
-- widget_settings.welcome_message (falling back to DEFAULT_WELCOME_MESSAGE
-- when absent) — chatbot_settings.welcome_message is never read on that
-- path at all today. That's a pre-existing inconsistency, not introduced by
-- this change (out of scope to fix the superadmin Assistant page itself
-- here); the new CLIENT-facing "Message d'accueil" field in
-- features/client/actions.ts:updateChatbotPersonalization was therefore
-- deliberately wired to widget_settings.welcome_message — the only field
-- that actually reaches what a real visitor sees — so item 7's requirement
-- ("le message affiché réellement dans le widget doit utiliser cette
-- configuration") is genuinely true, not just true in the admin preview.
-- No new column, no migration needed for this field. See the final report
-- for the full explanation.
-- =========================================================================
