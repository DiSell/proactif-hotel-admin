-- =========================================================================
-- Proactif System — Phase B integrations layer (availability + reservations
-- routing, capability model, inventory mapping, quotes, reservation
-- idempotency/operations, reservation audit log).
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql / 0002_rag.sql / 0003_site_analysis_consent.sql
-- / 0004_accommodation_types.sql.
--
-- PROPOSED, NOT YET APPLIED. Written for review; apply it through your own
-- Supabase workflow (dashboard SQL editor / `supabase db push`) when ready
-- — nothing in this codebase executes migrations automatically. This file
-- has never been applied anywhere, so it is edited in place across review
-- rounds rather than patched by a follow-up migration.
--
-- Still no real provider connected by this migration alone: it creates the
-- schema a real integration would be configured in, but ships no row, no
-- adapter, no write path. See src/features/availability/resolver.ts
-- (DatabaseAvailabilityProviderResolver), src/features/integrations/
-- (registry.ts, types.ts) and src/features/reservations/types.ts for the
-- application-side contracts this schema backs.
-- =========================================================================

-- =========================================================================
-- hotel_integrations
-- =========================================================================
-- One row per configured provider connection for a hotel. integration_type
-- alone NEVER implies a capability (e.g. a PMS row does not imply
-- reservation_create) — capabilities is the only source of truth for what's
-- actually authorized, and it's checked by the orchestrator (Phase C)
-- before every call, independently of what the adapter object technically
-- implements.
create table public.hotel_integrations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  provider text not null,                    -- adapter key, e.g. "mews", "amenitiz"
  integration_type text not null check (integration_type in ('PMS', 'BOOKING_ENGINE', 'CHANNEL_MANAGER')),
  status text not null default 'disconnected' check (status in ('disconnected', 'configured', 'active', 'error')),
  -- Validated subset of IntegrationCapability (src/features/integrations/types.ts) — <@ (containment) rejects any value outside the list below.
  capabilities text[] not null default '{}',
  configuration jsonb not null default '{}',  -- NON-sensitive only (e.g. property id, region) — never a secret here.
  -- Opaque pointer to a future secrets vault — never the secret itself. No vault implemented in Phase B (real strategy deferred to Phase C's first real adapter).
  credential_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_integrations_capabilities_valid check (
    capabilities <@ array['availability','rates','booking_url','reservation_read','reservation_create','reservation_modify','reservation_cancel']::text[]
  )
);

-- Required for the tenant-safe composite FKs below (capability routes, inventory mappings, quotes, operations, audit log).
create unique index hotel_integrations_id_hotel_id_key on public.hotel_integrations (id, hotel_id);
-- Includes integration_type (not just hotel_id + provider): a hotel can legitimately connect the same provider brand twice for two different roles — e.g. "mews" as a PMS AND "mews" as a booking engine — and must not be blocked from doing so.
create unique index hotel_integrations_hotel_provider_type_key on public.hotel_integrations (hotel_id, provider, integration_type);
create index hotel_integrations_hotel_id_idx on public.hotel_integrations (hotel_id);

alter table public.hotel_integrations enable row level security;
create policy "superadmin full access" on public.hotel_integrations
  for all using (public.is_superadmin()) with check (public.is_superadmin());
grant select, insert, update, delete on public.hotel_integrations to authenticated;
revoke all on public.hotel_integrations from anon;

-- =========================================================================
-- hotel_integration_capability_routes
-- =========================================================================
-- Explicit routing only — never an implicit fallback. If no row exists for
-- (hotel_id, capability), that capability is simply unavailable for that
-- hotel; never a guessed integration.
create table public.hotel_integration_capability_routes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  capability text not null check (capability in (
    'availability','rates','booking_url','reservation_read','reservation_create','reservation_modify','reservation_cancel'
  )),
  integration_id uuid not null,
  priority integer not null default 1,
  created_at timestamptz not null default now(),
  -- Tenant-safe: impossible to route to another hotel's integration at the Postgres level. CASCADE is correct here (unlike reservation_operations/reservation_audit_log below): a route is pure routing configuration, not a historical record — if the integration it points to is gone, the route pointing at it is meaningless and should go with it.
  foreign key (integration_id, hotel_id) references public.hotel_integrations (id, hotel_id) on delete cascade,
  unique (hotel_id, capability, priority)
);
create index hotel_integration_capability_routes_lookup_idx on public.hotel_integration_capability_routes (hotel_id, capability, priority);

alter table public.hotel_integration_capability_routes enable row level security;
create policy "superadmin full access" on public.hotel_integration_capability_routes
  for all using (public.is_superadmin()) with check (public.is_superadmin());
grant select, insert, update, delete on public.hotel_integration_capability_routes to authenticated;
revoke all on public.hotel_integration_capability_routes from anon;

-- =========================================================================
-- accommodation_inventory_mappings
-- =========================================================================
-- Relies on accommodation_types_id_hotel_id_key (composite unique index on
-- (id, hotel_id)), already created directly in 0004_accommodation_types.sql
-- — that table now ships its own tenant-safe composite key from the start
-- (room_photos, in the same migration, needs it too), so nothing further is
-- added to accommodation_types here.
--
-- One external_accommodation_id per (accommodation_type, integration) — the
-- same internal accommodation_type_id can map to a different id per PMS /
-- booking engine / channel manager. Replaces, once populated, the Phase A
-- simplification documented in applyAvailabilityToCandidates.ts (which
-- today treats externalAccommodationId as directly comparable to our
-- internal id, for lack of a real mapping).
create table public.accommodation_inventory_mappings (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  integration_id uuid not null,
  accommodation_type_id uuid not null,
  external_accommodation_id text not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Configuration, not history — CASCADE is correct (same reasoning as capability_routes above).
  foreign key (integration_id, hotel_id) references public.hotel_integrations (id, hotel_id) on delete cascade,
  foreign key (accommodation_type_id, hotel_id) references public.accommodation_types (id, hotel_id) on delete cascade,
  unique (hotel_id, integration_id, accommodation_type_id),
  unique (hotel_id, integration_id, external_accommodation_id)
);
create index accommodation_inventory_mappings_lookup_idx on public.accommodation_inventory_mappings (hotel_id, integration_id, accommodation_type_id);

alter table public.accommodation_inventory_mappings enable row level security;
create policy "superadmin full access" on public.accommodation_inventory_mappings
  for all using (public.is_superadmin()) with check (public.is_superadmin());
grant select, insert, update, delete on public.accommodation_inventory_mappings to authenticated;
revoke all on public.accommodation_inventory_mappings from anon;

-- =========================================================================
-- booking_quotes
-- =========================================================================
-- A server-resolved, tenant-safe snapshot of ONE specific offer — created
-- from a real checkAvailability result (Phase A/C), never from bare
-- browser-supplied fields. Its id (a random, non-guessable uuid) IS the
-- opaque `quoteRef` the browser is handed: the browser never sees or
-- controls hotel_id, integration_id, accommodation_type_id,
-- external_accommodation_id, provider_offer_id, dates, occupancy, price or
-- currency independently — it only ever round-trips this one id back to
-- CreateReservationRequest.quoteRef (src/features/reservations/types.ts),
-- and the server resolves every transactional fact from THIS row, never
-- from anything else the client claims alongside it.
--
-- status supports the re-validation rule documented in
-- ReservationQuoteSummary / ReservationErrorCode (OFFER_EXPIRED /
-- PRICE_CHANGED / NO_LONGER_AVAILABLE): Phase C is expected to flip a quote
-- to 'expired'/'invalidated' rather than let a stale row silently keep
-- authorizing a reservation. Nothing in Phase B sets these transitions —
-- there is no write path yet — this column only makes them representable.
create table public.booking_quotes (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  integration_id uuid not null,
  accommodation_type_id uuid not null,
  external_accommodation_id text not null,
  -- Opaque provider offer/rate id, if the provider emits one (see AvailabilityItem.offerId, Phase A) — nullable, never assumed universal.
  provider_offer_id text,
  check_in date not null,
  check_out date not null,
  adults integer not null,
  children_count integer not null default 0,
  children_ages integer[],
  rooms integer not null default 1,
  -- Nullable, like AvailabilityItem.totalPrice/nightlyPrice (Phase A) — not every provider prices every offer.
  total_price numeric(12, 2),
  currency text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'consumed', 'expired', 'invalidated')),
  -- Ephemeral configuration snapshot, not a permanent audit record — CASCADE is correct (unlike reservation_operations/reservation_audit_log below, which reference booking_quotes and DO need to survive/block on deletion instead).
  foreign key (integration_id, hotel_id) references public.hotel_integrations (id, hotel_id) on delete cascade,
  foreign key (accommodation_type_id, hotel_id) references public.accommodation_types (id, hotel_id) on delete cascade,
  constraint booking_quotes_dates_order check (check_out > check_in)
);

-- Required for the tenant-safe composite FK from reservation_operations below.
create unique index booking_quotes_id_hotel_id_key on public.booking_quotes (id, hotel_id);
create index booking_quotes_hotel_id_idx on public.booking_quotes (hotel_id);
create index booking_quotes_hotel_integration_idx on public.booking_quotes (hotel_id, integration_id);

alter table public.booking_quotes enable row level security;
create policy "superadmin full access" on public.booking_quotes
  for all using (public.is_superadmin()) with check (public.is_superadmin());
grant select, insert, update, delete on public.booking_quotes to authenticated;
revoke all on public.booking_quotes from anon;

-- =========================================================================
-- reservation_operations
-- =========================================================================
-- The ONLY place idempotency is actually acquired — by INSERT, never by a
-- SELECT-to-check-absence followed by a provider call (that pattern has a
-- race: two concurrent requests can both see "no row yet" and both call the
-- provider). The unique constraint below is the real lock: the first INSERT
-- with a given (hotel_id, integration_id, operation_type, idempotency_key)
-- wins and may proceed to call the provider; a concurrent second INSERT
-- with the same key raises unique_violation and MUST load the existing row
-- instead of ever calling the provider a second time. This table is
-- deliberately mutable (status/external_reservation_id/provider_reference/
-- error_code/updated_at all change as the operation progresses,
-- PENDING -> SUCCEEDED/FAILED/UNKNOWN) — the opposite of
-- reservation_audit_log below, which is the append-only historical trail
-- and must never be used for this locking role.
create table public.reservation_operations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  integration_id uuid not null,
  operation_type text not null check (operation_type in ('create', 'modify', 'cancel')),
  idempotency_key text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  quote_id uuid,
  external_reservation_id text,
  provider_reference text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- ON DELETE RESTRICT, deliberately not CASCADE/SET NULL: an integration that has ever been used for a reservation attempt can never be physically removed out from under that history — disable it (hotel_integrations.status = 'disconnected'/'error') instead. A composite SET NULL here would try to null hotel_id too (NOT NULL on this table) — the exact bug this migration fixes; RESTRICT never touches existing rows at all.
  foreign key (integration_id, hotel_id) references public.hotel_integrations (id, hotel_id) on delete restrict,
  -- Same tenant-safety pattern as every other composite FK in this schema — a quote from another hotel can never be attached to an operation for this one. RESTRICT for the same reason as above: an operation's quote must never silently disappear out from under it.
  foreign key (quote_id, hotel_id) references public.booking_quotes (id, hotel_id) on delete restrict,
  unique (hotel_id, integration_id, operation_type, idempotency_key)
);

create index reservation_operations_hotel_id_idx on public.reservation_operations (hotel_id);

alter table public.reservation_operations enable row level security;
create policy "superadmin full access" on public.reservation_operations
  for all using (public.is_superadmin()) with check (public.is_superadmin());
-- No DELETE: removing a claim row would defeat the one thing this table
-- exists to guarantee — a deleted PENDING/SUCCEEDED row would let a
-- replayed request with the same idempotency_key sail past the unique
-- constraint and call the provider a second time.
grant select, insert, update on public.reservation_operations to authenticated;
revoke all on public.reservation_operations from anon;

-- =========================================================================
-- reservation_audit_log
-- =========================================================================
-- A pure, append-only historical trail — distinct from reservation_operations
-- above, and never used to acquire idempotency (that lock lives entirely in
-- reservation_operations' unique constraint). Deliberately no PII column
-- (no name/email/phone) — only enough to trace what was attempted.
--
-- hotel_id uses ON DELETE RESTRICT, not CASCADE (unlike every other hotel_id
-- FK in this migration) — same reasoning, and same precedent, as
-- site_analysis_consents.hotel_id in 0003_site_analysis_consent.sql: this
-- table is a permanent audit trail, and a hotel deletion must never be able
-- to silently erase the transactional history associated with it. RESTRICT
-- on integration_id below already prevents deleting an integration out from
-- under its audit trail — RESTRICT on hotel_id closes the same gap one
-- level up. No feature in this codebase deletes a hotel today, so this
-- changes no current behavior; it only matters once hotel deletion exists,
-- at which point it forces a deliberate decision instead of a silent
-- cascade.
create table public.reservation_audit_log (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete restrict,
  integration_id uuid not null,
  action text not null check (action in ('create', 'get', 'modify', 'cancel')),
  idempotency_key text,
  external_reservation_id text,
  status text not null,
  error_code text,
  created_at timestamptz not null default now(),
  -- ON DELETE RESTRICT — same reasoning as reservation_operations above: an audit trail must survive the integration it documents, never be silently truncated or corrupted by its deletion.
  foreign key (integration_id, hotel_id) references public.hotel_integrations (id, hotel_id) on delete restrict
);

create index reservation_audit_log_hotel_id_idx on public.reservation_audit_log (hotel_id);

-- =========================================================================
-- Immutability trigger — same discipline as
-- enforce_site_analysis_consent_immutability (0003): makes the append-only
-- guarantee physical, not just conventional. Unlike site_analysis_consents,
-- there is no revoked_at-style exception here — NO column on this table may
-- ever change after insert, because this table is a pure historical trail,
-- never a mutable idempotency lock (that role belongs entirely to
-- reservation_operations above).
-- =========================================================================
create function public.enforce_reservation_audit_log_immutability()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'reservation_audit_log is an append-only audit log: no column may be changed after insert (row id=%)',
    old.id;
end;
$$;

create trigger reservation_audit_log_immutable
  before update on public.reservation_audit_log
  for each row
  execute function public.enforce_reservation_audit_log_immutability();

-- =========================================================================
-- Row Level Security — narrow, per-operation policies (not FOR ALL), same
-- pattern as site_analysis_consents (0003): the table only ever needs
-- SELECT/INSERT from the app. No UPDATE policy (enforced twice over — by
-- the trigger above, and by the absence of an UPDATE grant below) and no
-- DELETE policy at all, not even for a superadmin.
-- =========================================================================
alter table public.reservation_audit_log enable row level security;

create policy "superadmin can read audit log" on public.reservation_audit_log
  for select using (public.is_superadmin());

create policy "superadmin can insert audit log" on public.reservation_audit_log
  for insert with check (public.is_superadmin());

-- No UPDATE, no DELETE — matching the absence of an UPDATE/DELETE policy
-- above: the `authenticated` role can never update or delete a row in this
-- table, by grant as well as by policy and trigger.
grant select, insert on public.reservation_audit_log to authenticated;
revoke all on public.reservation_audit_log from anon;
