-- =========================================================================
-- Proactif System — host-booking CTA mode for the public widget.
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql through 0009_widget_service_role_permissions.sql
-- (0009 is already applied and validated manually in Supabase; it is not
-- touched here, only built on top of).
--
-- PROPOSED, NOT YET APPLIED. Apply it through your own Supabase workflow
-- (dashboard SQL editor / `supabase db push`) when ready — nothing in this
-- codebase executes migrations automatically. No hotel row is updated by
-- this migration — see the separate, hand-run UPDATE statement provided
-- alongside this task for configuring Le 1837 specifically.
--
-- Context: replaces the abandoned reservation_requests approach. In MODE
-- STANDARD, Proactif never checks real availability, never quotes a real
-- price, and never creates a reservation. When a hotel already has a
-- booking module embedded on its own site (confirmed for Le 1837: a "My
-- Groom Service" widget opened by clicking #resa-toggle-menu — no
-- documented public API/event exists for it), the widget's "Réserver" CTA
-- can now ask public/widget.js (which runs on the HOTEL's own page, unlike
-- the chat iframe) to trigger that existing module directly, instead of
-- only ever linking to an external booking_url.
--
-- Only two columns on hotels — no new table. booking_action_mode picks
-- between the two mechanisms; host_booking_trigger carries the trusted,
-- admin-configured detail for the second one. Neither column needs a new
-- GRANT: ADD COLUMN on an existing table is covered by that table's
-- existing table-level grants (Postgres privileges are per-table, not
-- per-column, unless column-level grants were used — they never have been
-- for `hotels`, see 0001_init.sql/0009). service_role's existing SELECT on
-- hotels (0009) and authenticated's existing SELECT/INSERT/UPDATE/DELETE
-- (0001) both already cover these two new columns automatically.
-- =========================================================================

alter table public.hotels
  add column booking_action_mode text not null default 'url'
    check (booking_action_mode in ('url', 'host_widget')),
  -- No structural validation of the JSON shape here beyond "is a JSON
  -- object" — deliberately. The real shape ({strategy:"click", selector})
  -- is enforced by hostBookingTriggerSchema (Zod) at every write path (the
  -- admin form's server action) and re-validated at every read path
  -- (buildBookingAction, buildPublicWidgetConfig) via the same schema —
  -- see src/features/hotels/hostBookingTrigger.ts. A CSS selector has no
  -- meaningful SQL-level grammar to validate against; that check belongs
  -- in TypeScript, not Postgres.
  add column host_booking_trigger jsonb
    check (host_booking_trigger is null or jsonb_typeof(host_booking_trigger) = 'object');
