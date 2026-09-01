-- =========================================================================
-- Proactif System — hotel_spa_settings: per-hotel spa-booking configuration.
-- Additive only. Mirrors 0032_hotel_events.sql's own shape and RLS
-- discipline exactly: a small, low-risk, per-hotel CRUD resource with no
-- external side effect, where RLS is the real gate and writes go through
-- the session-bound client (see features/spa/actions.ts) — NOT the
-- SECURITY-DEFINER-only discipline used by 0034_spa_bookings.sql, which
-- exists specifically because bookings enforce real business rules
-- (capacity, hours, race-safety) that plain RLS cannot.
--
-- At most one row per hotel (hotel_id unique). No row, or enabled = false,
-- both mean "this hotel does not offer spa booking" — every reader treats
-- them identically. slot_duration_minutes is the SINGLE source of truth for
-- how long a slot lasts: no fixed duration (e.g. 120) is ever hardcoded
-- anywhere in the application code that consumes this table.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

create table public.hotel_spa_settings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,

  enabled boolean not null default false,

  opens_at time not null default '10:00',
  closes_at time not null default '20:00',
  slot_duration_minutes integer not null default 120,
  capacity_per_slot integer not null default 4,
  price_per_person numeric(10, 2),
  allow_non_residents boolean not null default true,
  advance_booking_days integer not null default 30,
  min_notice_hours integer not null default 2,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint hotel_spa_settings_hours_order check (closes_at > opens_at),
  constraint hotel_spa_settings_slot_duration_positive check (slot_duration_minutes > 0),
  constraint hotel_spa_settings_capacity_positive check (capacity_per_slot > 0),
  constraint hotel_spa_settings_advance_days_range check (advance_booking_days >= 0 and advance_booking_days <= 365),
  constraint hotel_spa_settings_min_notice_range check (min_notice_hours >= 0 and min_notice_hours <= 168),
  constraint hotel_spa_settings_price_non_negative check (price_per_person is null or price_per_person >= 0)
);

comment on table public.hotel_spa_settings is
  'Per-hotel spa-booking configuration (task: "réservation spa conversationnelle"). At most one row per hotel. enabled=false or a missing row both mean "no spa booking offered". The "duration evenly divides the opening window" rule is validated at the application layer (features/spa/schema.ts, .superRefine) — not a DB CHECK, since time arithmetic modulo is awkward in Postgres and this rule is about UX (clean slot boundaries), not data integrity.';

comment on column public.hotel_spa_settings.slot_duration_minutes is
  'The SINGLE source of truth for slot length. Every slot boundary/label anywhere in the application (features/spa/, features/rag/) is derived from this column — never a hardcoded duration.';

-- Reuses the existing shared trigger function from 0001_init.sql — same
-- pattern already used for hotels/chatbot_settings/hotel_partners/hotel_events.
create trigger set_updated_at before update on public.hotel_spa_settings
  for each row execute function public.set_updated_at();

alter table public.hotel_spa_settings enable row level security;

create policy "superadmin full access to hotel_spa_settings" on public.hotel_spa_settings
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "hotel_admin full access to own hotel_spa_settings" on public.hotel_spa_settings
  for all using (public.is_hotel_admin_for(hotel_id)) with check (public.is_hotel_admin_for(hotel_id));

-- `authenticated` gets broad grants since RLS above is the real gate (same
-- discipline as hotel_events/hotel_partners). `service_role` gets SELECT
-- only — the chatbot pipeline (features/spa/booking.ts) only ever reads
-- this table, never writes it. `anon` gets nothing.
grant select, insert, update, delete on public.hotel_spa_settings to authenticated;
grant select on public.hotel_spa_settings to service_role;
revoke all on public.hotel_spa_settings from anon;
