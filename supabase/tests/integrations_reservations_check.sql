-- Constraint checks for 0005_integrations_reservations.sql — run this in the
-- Supabase SQL editor (or psql connected to the project) AFTER that
-- migration has been applied.
--
-- Nothing here can be proven by vitest (no Postgres in this repo's test
-- runner — see src/features/integrations/integrationsMigration.test.ts for
-- the static/source-level guards on the migration text instead). This
-- script is the real proof: it actually attempts the forbidden operations
-- and expects Postgres to reject every one of them.
--
-- None of these tables reference auth.users — every fixture here is a
-- throwaway row this script inserts directly and rolls back. Run as a
-- superuser/owner (bypasses RLS on purpose, to isolate what's under test to
-- the constraints/triggers/grants, not RLS — rls_check.sql already covers
-- RLS).
--
-- Three requirements from the review are deliberately NOT re-proven here
-- because they are TypeScript contract guarantees, not Postgres
-- constraints — already covered by build-checked @ts-expect-error tests in
-- src/features/reservations/types.test.ts and unit tests in
-- src/features/availability/resolver.test.ts:
--   - price/dates can't be supplied separately from a quote
--     (CreateReservationRequest has no stay/quotedPrice field at all);
--   - an unknown provider key / capability-DB-without-adapter /
--     adapter-without-capability-DB are all refused by
--     pickAvailabilityProvider + MapProviderRegistry.

begin;

-- ---- Fixtures ----

insert into public.hotels (id, name, slug, widget_key)
values
  ('00000000-0000-0000-0000-0000000000c1', 'Integrations Check Hotel A', 'integrations-check-hotel-a', 'ps_live_integrationscheckcc1'),
  ('00000000-0000-0000-0000-0000000000c2', 'Integrations Check Hotel B', 'integrations-check-hotel-b', 'ps_live_integrationscheckcc2');

insert into public.hotel_integrations (id, hotel_id, provider, integration_type, status, capabilities)
values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1', 'mews', 'PMS', 'active', array['availability', 'reservation_create']),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000c2', 'mews', 'PMS', 'active', array['availability']);

insert into public.accommodation_types (id, hotel_id, name)
values
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000c1', 'Suite Check A'),
  ('00000000-0000-0000-0000-0000000000c7', '00000000-0000-0000-0000-0000000000c2', 'Suite Check B');

insert into public.booking_quotes (id, hotel_id, integration_id, accommodation_type_id, external_accommodation_id, check_in, check_out, adults, children_count, rooms)
values
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c4', 'ext-acc-a', '2026-09-01', '2026-09-03', 2, 0, 1),
  ('00000000-0000-0000-0000-0000000000c8', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000c7', 'ext-acc-b', '2026-09-01', '2026-09-03', 2, 0, 1);

-- ---- 1) hotel_integrations: capabilities <@ containment — an unknown capability value is rejected, specifically by hotel_integrations_capabilities_valid ----
-- Unlike a bare "when others" catch, this asserts BOTH the SQLSTATE
-- (23514 = check_violation, ruling out an unrelated error class like a
-- unique_violation or FK failure) AND that the error message names the
-- specific constraint — so this test cannot pass on just any SQL error.
do $$
declare
  rejected boolean := false;
  err_state text;
  err_message text;
begin
  begin
    insert into public.hotel_integrations (hotel_id, provider, integration_type, capabilities)
    values ('00000000-0000-0000-0000-0000000000c1', 'rogue-provider', 'PMS', array['not_a_real_capability']);
  exception
    when others then
      rejected := true;
      err_state := sqlstate;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: hotel_integrations accepted a capability value outside the validated list';
  end if;

  if err_state <> '23514' then
    raise exception 'BUG: the insert was rejected, but not with check_violation (SQLSTATE 23514) as expected from hotel_integrations_capabilities_valid — got sqlstate=%, message=%', err_state, err_message;
  end if;

  if err_message not like '%hotel_integrations_capabilities_valid%' then
    raise exception 'BUG: the insert was rejected with check_violation, but NOT by hotel_integrations_capabilities_valid specifically — got: %', err_message;
  end if;

  raise notice 'OK: unknown capability value rejected specifically by hotel_integrations_capabilities_valid, SQLSTATE 23514 (%)', err_message;
end $$;

-- ---- 2) hotel_integrations: the same provider CAN be connected twice for two different roles (UNIQUE now includes integration_type) ----
do $$
begin
  insert into public.hotel_integrations (hotel_id, provider, integration_type, capabilities)
  values ('00000000-0000-0000-0000-0000000000c1', 'mews', 'BOOKING_ENGINE', array['availability']);
  raise notice 'OK: "mews" connected a second time for hotel A under a different integration_type (BOOKING_ENGINE alongside PMS) without violating any UNIQUE constraint';
end $$;

-- ---- 3) hotel_integration_capability_routes cannot route to another hotel's integration ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    insert into public.hotel_integration_capability_routes (hotel_id, capability, integration_id, priority)
    values ('00000000-0000-0000-0000-0000000000c2', 'availability', '00000000-0000-0000-0000-0000000000c3', 1);
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'SECURITY BUG: routed capability "availability" for hotel B to an integration that belongs to hotel A';
  end if;

  raise notice 'OK: cross-hotel capability route rejected by the composite FK (%)', err_message;
end $$;

-- ---- 4) accommodation_inventory_mappings cannot mix an accommodation_type from one hotel with an integration from another ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    insert into public.accommodation_inventory_mappings (hotel_id, integration_id, accommodation_type_id, external_accommodation_id)
    values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c7', 'cross-tenant-ext-id');
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'SECURITY BUG: mapped hotel A''s integration to an accommodation_type that belongs to hotel B';
  end if;

  raise notice 'OK: cross-hotel accommodation_type mapping rejected by the composite FK (%)', err_message;
end $$;

-- ---- 5) booking_quotes cannot mix an accommodation_type from one hotel with hotel_id/integration from another ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    insert into public.booking_quotes (hotel_id, integration_id, accommodation_type_id, external_accommodation_id, check_in, check_out, adults, children_count, rooms)
    values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c7', 'cross-tenant-ext-id', '2026-09-01', '2026-09-03', 2, 0, 1);
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'SECURITY BUG: created a quote for hotel A referencing an accommodation_type that belongs to hotel B';
  end if;

  raise notice 'OK: cross-hotel accommodation_type on a quote rejected by the composite FK (%)', err_message;
end $$;

-- ---- 6) booking_quotes rejects check_out <= check_in ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    insert into public.booking_quotes (hotel_id, integration_id, accommodation_type_id, external_accommodation_id, check_in, check_out, adults, children_count, rooms)
    values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c4', 'ext-acc-a', '2026-09-05', '2026-09-05', 2, 0, 1);
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: booking_quotes accepted check_out = check_in (should require check_out > check_in)';
  end if;

  raise notice 'OK: check_out <= check_in rejected by booking_quotes_dates_order (%)', err_message;
end $$;

-- ---- 7) booking_quotes.status stays mutable (contrast with reservation_audit_log's immutability below) — needed for Phase C to mark a quote 'expired'/'invalidated' ----
do $$
begin
  update public.booking_quotes set status = 'expired' where id = '00000000-0000-0000-0000-0000000000c5';
  if (select status from public.booking_quotes where id = '00000000-0000-0000-0000-0000000000c5') <> 'expired' then
    raise exception 'BUG: booking_quotes.status update did not take effect';
  end if;
  raise notice 'OK: booking_quotes.status is mutable (active -> expired) — quotes are not an audit log';
end $$;

-- ---- 8) reservation_operations: atomic idempotency claim — a second INSERT with the same (hotel_id, integration_id, operation_type, idempotency_key) is rejected ----
insert into public.reservation_operations (hotel_id, integration_id, operation_type, idempotency_key, status, quote_id)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'create', 'idem-check-1', 'PENDING', '00000000-0000-0000-0000-0000000000c5');

do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    insert into public.reservation_operations (hotel_id, integration_id, operation_type, idempotency_key, status, quote_id)
    values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'create', 'idem-check-1', 'PENDING', '00000000-0000-0000-0000-0000000000c5');
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: a second concurrent-style INSERT with the same (hotel_id, integration_id, operation_type, idempotency_key) was NOT rejected — this is the exact race the atomic-claim design exists to prevent. Two callers could both believe they own the right to call the provider.';
  end if;

  raise notice 'OK: duplicate claim for the same (hotel_id, integration_id, operation_type, idempotency_key) rejected at INSERT time — the constraint IS the lock (%)', err_message;
end $$;

-- ---- 9) reservation_operations: the SAME idempotency_key on a DIFFERENT operation_type does not collide ----
do $$
begin
  insert into public.reservation_operations (hotel_id, integration_id, operation_type, idempotency_key, status)
  values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'modify', 'idem-check-1', 'PENDING');
  raise notice 'OK: idempotency_key ''idem-check-1'' reused under operation_type=modify did not collide with the existing create row';
end $$;

-- ---- 10) reservation_operations: after a create moves to UNKNOWN, no blind retry can reuse the same claim to call the provider again ----
update public.reservation_operations set status = 'UNKNOWN' where hotel_id = '00000000-0000-0000-0000-0000000000c1' and operation_type = 'create' and idempotency_key = 'idem-check-1';

do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    insert into public.reservation_operations (hotel_id, integration_id, operation_type, idempotency_key, status, quote_id)
    values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'create', 'idem-check-1', 'PENDING', '00000000-0000-0000-0000-0000000000c5');
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: a blind retry INSERT after status=UNKNOWN was able to acquire a fresh claim under the same idempotency_key — this could trigger a second provider call after an ambiguous timeout, which is exactly what UNKNOWN exists to prevent';
  end if;

  raise notice 'OK: the claim row for idem-check-1/create still blocks a fresh INSERT even after moving to UNKNOWN — a caller MUST load the existing row (and reconcile) instead of ever re-inserting (%)', err_message;
end $$;

-- ---- 11) reservation_operations.quote_id cannot reference a quote from another hotel ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    insert into public.reservation_operations (hotel_id, integration_id, operation_type, idempotency_key, status, quote_id)
    values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'create', 'idem-check-cross-hotel-quote', 'PENDING', '00000000-0000-0000-0000-0000000000c8');
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'SECURITY BUG: a reservation_operations row for hotel A was created referencing hotel B''s quote (quoteRef) — a cross-tenant quoteRef must never be acceptable';
  end if;

  raise notice 'OK: a quoteRef belonging to another hotel is rejected by the composite (quote_id, hotel_id) FK (%)', err_message;
end $$;

-- ---- 12) reservation_operations/reservation_audit_log: an integration used for a reservation attempt cannot be physically deleted (RESTRICT) ----
insert into public.reservation_audit_log (hotel_id, integration_id, action, idempotency_key, status)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000c3', 'create', 'idem-check-1', 'PENDING');

do $$
declare
  rejected boolean := false;
  err_message text;
  hotel_id_after uuid;
begin
  begin
    delete from public.hotel_integrations where id = '00000000-0000-0000-0000-0000000000c3';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: deleted a hotel_integrations row that is referenced by reservation_operations/reservation_audit_log — that history must survive; disabling the integration (status) is the only supported way to retire it';
  end if;

  -- The delete failed entirely (whole statement rolled back by Postgres on
  -- the constraint violation) — hotel_id on the referencing rows is
  -- necessarily untouched. Verified explicitly rather than assumed.
  select hotel_id into hotel_id_after from public.reservation_operations where hotel_id = '00000000-0000-0000-0000-0000000000c1' and operation_type = 'create' and idempotency_key = 'idem-check-1';
  if hotel_id_after is distinct from '00000000-0000-0000-0000-0000000000c1'::uuid then
    raise exception 'BUG: hotel_id on reservation_operations was altered by the failed delete attempt (got %)', hotel_id_after;
  end if;

  raise notice 'OK: DELETE on a referenced hotel_integrations row rejected by RESTRICT (%), and hotel_id on the historical rows remains exactly what it was — never nulled', err_message;
end $$;

-- ---- 13) reservation_audit_log survives hotel deletion attempts — a hotel with existing audit history cannot be deleted, and the history is untouched ----
do $$
declare
  rejected boolean := false;
  err_message text;
  audit_row_count_after int;
begin
  begin
    delete from public.hotels where id = '00000000-0000-0000-0000-0000000000c1';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'SECURITY BUG: deleted hotel A even though it has an existing reservation_audit_log entry — the audit trail must never be silently erasable by deleting the hotel it documents';
  end if;

  select count(*) into audit_row_count_after
  from public.reservation_audit_log
  where hotel_id = '00000000-0000-0000-0000-0000000000c1' and idempotency_key = 'idem-check-1';

  if audit_row_count_after <> 1 then
    raise exception 'BUG: reservation_audit_log row for hotel A is missing (or duplicated) after the rejected DELETE — expected exactly 1, found %', audit_row_count_after;
  end if;

  raise notice 'OK: DELETE on hotel A rejected while its reservation_audit_log entry exists (%), and that entry is still present, untouched — hotel_id ON DELETE RESTRICT holds', err_message;
end $$;

-- ---- 14) reservation_audit_log is append-only: UPDATE is rejected by the immutability trigger ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    update public.reservation_audit_log set status = 'tampered' where hotel_id = '00000000-0000-0000-0000-0000000000c1' and idempotency_key = 'idem-check-1';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: reservation_audit_log accepted an UPDATE (immutability trigger did not fire)';
  end if;

  if err_message not like '%append-only audit log%' then
    raise exception 'BUG: the UPDATE was rejected, but NOT by the immutability trigger — got: %', err_message;
  end if;

  raise notice 'OK: UPDATE on reservation_audit_log rejected by the immutability trigger (%)', err_message;
end $$;

-- ---- 15) reservation_audit_log: DELETE not available via the application role ----
do $$
declare
  rejected boolean := false;
  err_state text;
  err_message text;
begin
  execute 'set local role authenticated';

  begin
    delete from public.reservation_audit_log where hotel_id = '00000000-0000-0000-0000-0000000000c1' and idempotency_key = 'idem-check-1';
  exception
    when others then
      rejected := true;
      err_state := sqlstate;
      err_message := sqlerrm;
  end;

  -- Restore the original (privileged) role immediately, regardless of
  -- outcome, so every statement after this block runs with the SQL
  -- editor's original privileges again.
  execute 'reset role';

  if not rejected then
    raise exception 'SECURITY BUG: authenticated role was able to delete a reservation_audit_log row';
  end if;

  if err_state <> '42501' then
    raise exception 'BUG: DELETE was rejected, but not with insufficient_privilege (SQLSTATE 42501) as expected from the missing GRANT — got sqlstate=%, message=%', err_state, err_message;
  end if;

  raise notice 'OK: DELETE rejected for authenticated role with insufficient_privilege (%)', err_message;
end $$;

-- ---- 16) reservation_audit_log: UPDATE not available via the application role either (no grant, in addition to the trigger) ----
do $$
declare
  rejected boolean := false;
  err_state text;
  err_message text;
begin
  execute 'set local role authenticated';

  begin
    update public.reservation_audit_log set status = 'tampered' where hotel_id = '00000000-0000-0000-0000-0000000000c1' and idempotency_key = 'idem-check-1';
  exception
    when others then
      rejected := true;
      err_state := sqlstate;
      err_message := sqlerrm;
  end;

  execute 'reset role';

  if not rejected then
    raise exception 'SECURITY BUG: authenticated role was able to attempt an update on reservation_audit_log';
  end if;

  if err_state <> '42501' then
    raise exception 'BUG: UPDATE was rejected, but not with insufficient_privilege (SQLSTATE 42501) as expected from the missing GRANT — got sqlstate=%, message=%', err_state, err_message;
  end if;

  raise notice 'OK: UPDATE rejected for authenticated role with insufficient_privilege, before the trigger even gets a chance to run (%)', err_message;
end $$;

rollback;
