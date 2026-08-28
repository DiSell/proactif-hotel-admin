-- Constraint/behavior checks for 0022_partner_transactional_consent.sql —
-- run this in the Supabase SQL editor (or psql connected to the project)
-- AFTER that migration has been applied (which itself requires
-- 0017_hotel_partner_consent.sql already applied).
--
-- BEGIN/ROLLBACK, same style as every other test script in this project —
-- everything this script writes is rolled back at the end. No real project
-- data is touched.
--
-- Scoped strictly to the NEW transactional-consent columns and their
-- independence from the existing recommendation consent — caller
-- authorization for other tables, the partner_requests state machine, and
-- the recommendation-consent flow itself are already covered by
-- hotel_partners_check.sql/partner_requests_check.sql and are NOT repeated
-- here.

begin;

do $$
declare
  hotel_a uuid;
  partner_already_recommended uuid; -- consent_status = 'accepted' BEFORE this migration's own columns are touched
  partner_fresh uuid;
  partner_b uuid; -- different hotel, for cross-tenant/cross-token isolation
  hotel_b uuid;
  whatsapp_status_check text;
  recommendation_status_check text;
  row_count_check integer;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Consent Test Hotel A', 'wa-consent-test-hotel-a', 'ps_live_wa_consent_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('WA Consent Test Hotel B', 'wa-consent-test-hotel-b', 'ps_live_wa_consent_test_b', 'active', true)
  returning id into hotel_b;

  -- Simulates a partner that ALREADY had consent_status = 'accepted' before
  -- this migration ever ran — the exact scenario the "no automatic
  -- migration to accepted" guarantee must hold for.
  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status, request_phone_e164)
  values (hotel_a, 'Restaurant Déjà Recommandé', 'restaurant', true, 'accepted', '+33611111111')
  returning id into partner_already_recommended;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status, request_phone_e164)
  values (hotel_a, 'Restaurant Neuf', 'restaurant', true, 'not_requested', '+33622222222')
  returning id into partner_fresh;

  insert into public.hotel_partners (hotel_id, name, category, is_active, consent_status, request_phone_e164)
  values (hotel_b, 'Taxi Hotel B', 'transport', true, 'accepted', '+33633333333')
  returning id into partner_b;

  raise notice 'OK: fixtures created';

  -- ================================================================
  -- 1) Default value: NO automatic backfill to 'accepted', regardless of
  -- the (unrelated) recommendation consent_status already on the row.
  -- ================================================================
  select whatsapp_consent_status, consent_status into whatsapp_status_check, recommendation_status_check
  from public.hotel_partners where id = partner_already_recommended;

  if whatsapp_status_check <> 'not_requested' then
    raise exception 'BUG: whatsapp_consent_status should default to not_requested, found %', whatsapp_status_check;
  end if;
  if recommendation_status_check <> 'accepted' then
    raise exception 'BUG: fixture setup itself is wrong — expected consent_status=accepted, found %', recommendation_status_check;
  end if;
  raise notice 'OK: a partner already accepted=recommendation has whatsapp_consent_status=not_requested by default — no auto-backfill';

  -- ================================================================
  -- 2) The two consents are independent columns — writing one never
  -- touches the other.
  -- ================================================================
  update public.hotel_partners
  set whatsapp_consent_status = 'pending', whatsapp_consent_token_hash = 'x', whatsapp_consent_requested_at = now()
  where id = partner_fresh;

  select consent_status into recommendation_status_check from public.hotel_partners where id = partner_fresh;
  if recommendation_status_check <> 'not_requested' then
    raise exception 'BUG: updating whatsapp_consent_status affected consent_status, found %', recommendation_status_check;
  end if;
  raise notice 'OK: writing whatsapp_consent_status never touches consent_status';

  update public.hotel_partners set consent_status = 'accepted' where id = partner_fresh;
  select whatsapp_consent_status into whatsapp_status_check from public.hotel_partners where id = partner_fresh;
  if whatsapp_status_check <> 'pending' then
    raise exception 'BUG: updating consent_status affected whatsapp_consent_status, found %', whatsapp_status_check;
  end if;
  raise notice 'OK: writing consent_status never touches whatsapp_consent_status (reverse direction)';

  -- ================================================================
  -- 3) CHECK constraint on whatsapp_consent_status — same closed
  -- vocabulary as consent_status.
  -- ================================================================
  begin
    update public.hotel_partners set whatsapp_consent_status = 'not_a_real_status' where id = partner_fresh;
    raise exception 'BUG: an invalid whatsapp_consent_status value was accepted';
  exception
    when check_violation then
      raise notice 'OK: whatsapp_consent_status CHECK constraint rejects an unknown value';
  end;

  -- ================================================================
  -- 4) Unique partial index on whatsapp_consent_token_hash — a token hash
  -- can never collide across two different partners (defense in depth;
  -- SHA-256 collisions are not the realistic risk here, uniqueness of the
  -- INDEX ITSELF is what's being verified).
  -- ================================================================
  update public.hotel_partners set whatsapp_consent_token_hash = 'shared-hash-value' where id = partner_fresh;
  begin
    update public.hotel_partners set whatsapp_consent_token_hash = 'shared-hash-value' where id = partner_b;
    raise exception 'BUG: two partners were allowed to share the same whatsapp_consent_token_hash';
  exception
    when unique_violation then
      raise notice 'OK: whatsapp_consent_token_hash uniqueness enforced';
  end;
  -- Reset for the next section — token uniqueness already proven above.
  update public.hotel_partners set whatsapp_consent_token_hash = null where id in (partner_fresh, partner_b);

  -- ================================================================
  -- 5) Cross-type token isolation: a value stored in consent_token_hash
  -- (recommendation) must never satisfy a lookup against
  -- whatsapp_consent_token_hash, and vice versa — they are different
  -- columns, so a query scoped to one can structurally never match a row
  -- via the other.
  -- ================================================================
  update public.hotel_partners set consent_token_hash = 'recommendation-hash-abc' where id = partner_fresh;

  select count(*) into row_count_check
  from public.hotel_partners
  where whatsapp_consent_token_hash = 'recommendation-hash-abc';
  if row_count_check <> 0 then
    raise exception 'BUG: a recommendation-consent token hash matched a whatsapp_consent_token_hash lookup';
  end if;
  raise notice 'OK: a recommendation token hash never matches a transactional-consent lookup (different column entirely)';

  -- ================================================================
  -- 6) Cross-partner isolation: scoping an UPDATE by id (as every real
  -- caller does) never touches a different partner's row, even one in the
  -- same 'pending' state.
  -- ================================================================
  update public.hotel_partners set whatsapp_consent_status = 'pending', whatsapp_consent_token_hash = 'token-for-fresh-only' where id = partner_fresh;
  update public.hotel_partners set whatsapp_consent_status = 'pending', whatsapp_consent_token_hash = 'token-for-b-only' where id = partner_b;

  update public.hotel_partners
  set whatsapp_consent_status = 'accepted', whatsapp_consent_responded_at = now()
  where whatsapp_consent_token_hash = 'token-for-fresh-only' and whatsapp_consent_status = 'pending';

  select whatsapp_consent_status into whatsapp_status_check from public.hotel_partners where id = partner_b;
  if whatsapp_status_check <> 'pending' then
    raise exception 'BUG: responding to partner_fresh''s token affected partner_b, found %', whatsapp_status_check;
  end if;
  raise notice 'OK: a response scoped by one partner''s own token hash never affects another partner''s row';

  -- ================================================================
  -- 7) Idempotent replay: a second "response" against an already-resolved
  -- row (status no longer 'pending') updates zero rows — same discipline
  -- as the recommendation consent's own respondToConsent().
  -- ================================================================
  update public.hotel_partners
  set whatsapp_consent_status = 'declined', whatsapp_consent_responded_at = now()
  where whatsapp_consent_token_hash = 'token-for-fresh-only' and whatsapp_consent_status = 'pending';

  select whatsapp_consent_status into whatsapp_status_check from public.hotel_partners where id = partner_fresh;
  if whatsapp_status_check <> 'accepted' then
    raise exception 'BUG: a replayed response overwrote an already-recorded answer, found %', whatsapp_status_check;
  end if;
  raise notice 'OK: replaying a response against an already-answered (non-pending) row changes nothing — idempotent by construction';

  -- ================================================================
  -- 8) No automatic deletion/merge anywhere in this flow.
  -- ================================================================
  select count(*) into row_count_check from public.hotel_partners where hotel_id in (hotel_a, hotel_b);
  if row_count_check <> 3 then
    raise exception 'BUG: expected exactly 3 hotel_partners rows total, found %', row_count_check;
  end if;
  raise notice 'OK: no row was ever automatically deleted or merged';

  raise notice 'OK: all partner_transactional_consent checks passed';
end $$;

rollback;
