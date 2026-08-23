-- Audit-log guarantee check for site_analysis_consents — run this in the
-- Supabase SQL editor (or psql connected to the project) AFTER
-- 0003_site_analysis_consent.sql has been applied.
--
-- Nothing here can be proven by vitest (no Postgres in this repo's test
-- runner — see src/features/knowledge/siteAnalysisConsentMigration.test.ts
-- for the static/source-level guards on the migration text instead). This
-- script is the real proof: it actually attempts the forbidden writes and
-- expects Postgres to reject every one of them.
--
-- Every "should fail" check below uses this shape, not a single flat
-- begin/exception block:
--
--   begin
--     <nested begin ... exception when others ... end>  -- isolates ONLY
--                                                        -- the risky
--                                                        -- statement
--     if not rejected then raise exception 'BUG: ...';  -- fails LOUDLY,
--                                                        -- outside any
--                                                        -- handler that
--                                                        -- could catch it
--     if err_message not like '...' then raise exception ...;  -- rules
--                                                        -- out a FK or
--                                                        -- other
--                                                        -- constraint
--                                                        -- producing a
--                                                        -- coincidental
--                                                        -- false positive
--   end
--
-- An earlier version of this script put the "raise exception 'BUG'" call
-- inside the SAME block as the "exception when others" handler meant to
-- catch the operation under test — which meant that BUG exception was
-- itself caught by that same handler and reported as "OK" regardless of
-- whether the operation actually failed. Every negative test below now
-- isolates the risky statement in its own nested block first.
--
-- public.profiles.id is a NOT NULL foreign key to auth.users(id) (see
-- 0001_init.sql) and profiles.email is NOT NULL with no default —
-- fabricating a throwaway profiles row here would require first
-- fabricating a matching auth.users row, which is schema-fragile and
-- edges into touching real auth data. Instead this script borrows the ids
-- of two REAL, EXISTING rows from public.profiles — read-only, used only
-- as an FK value on throwaway site_analysis_consents rows that get rolled
-- back. Nothing is ever inserted, updated, or deleted in public.profiles
-- or auth.users. Requires at least 2 existing rows in public.profiles;
-- the script raises a clear, explicit error up front if that's not met
-- rather than failing confusingly partway through.
--
-- Run as a superuser/owner (this script inserts a throwaway hotel
-- directly, bypassing RLS on purpose, to isolate what's under test to the
-- trigger and the grants — not RLS, which rls_check.sql already covers).

begin;

-- ---- Fixtures ----

-- public.hotels has no auth dependency — safe to insert a throwaway row
-- directly and roll it back.
insert into public.hotels (id, name, slug, widget_key)
values ('00000000-0000-0000-0000-0000000000a1', 'Consent Check Hotel', 'consent-check-hotel', 'ps_live_consentcheck00000');

create temporary table _consent_check_fixtures (
  profile_a uuid,
  profile_b uuid
) on commit drop;

insert into _consent_check_fixtures (profile_a, profile_b)
select p1.id, p2.id
from (select id from public.profiles order by created_at asc limit 1) p1,
     (select id from public.profiles order by created_at asc offset 1 limit 1) p2;

do $$
begin
  if not exists (
    select 1 from _consent_check_fixtures where profile_a is not null and profile_b is not null
  ) then
    raise exception 'SETUP: this script needs at least 2 existing rows in public.profiles (any role) to test confirmed_by immutability against a VALID second profile without fabricating auth.users data. Create a second admin account and re-run.';
  end if;
end $$;

insert into public.site_analysis_consents (id, hotel_id, domain, consent_version, consent_text, confirmed_by)
select
  '00000000-0000-0000-0000-0000000000a3',
  '00000000-0000-0000-0000-0000000000a1',
  'consent-check.example',
  'v1',
  'Consent text under test.',
  profile_a
from _consent_check_fixtures;

-- ---- 1) consent_text change after insert -> rejected ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    update public.site_analysis_consents set consent_text = 'tampered' where id = '00000000-0000-0000-0000-0000000000a3';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: consent_text was modified after insert (immutability trigger did not fire)';
  end if;

  if err_message not like '%append-only audit log%' then
    raise exception 'BUG: consent_text change was rejected, but NOT by the immutability trigger — got: %', err_message;
  end if;

  raise notice 'OK: consent_text change rejected by the immutability trigger (%)', err_message;
end $$;

-- ---- 2) domain change -> rejected ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    update public.site_analysis_consents set domain = 'other.example' where id = '00000000-0000-0000-0000-0000000000a3';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: domain was modified after insert (immutability trigger did not fire)';
  end if;

  if err_message not like '%append-only audit log%' then
    raise exception 'BUG: domain change was rejected, but NOT by the immutability trigger — got: %', err_message;
  end if;

  raise notice 'OK: domain change rejected by the immutability trigger (%)', err_message;
end $$;

-- ---- 3) confirmed_by change to a VALID different profile -> still rejected ----
-- Using a real, existing second profile id (not a nonexistent uuid) rules
-- out the FK constraint as the cause of rejection — only the immutability
-- trigger should be able to block this.
do $$
declare
  rejected boolean := false;
  err_message text;
  new_confirmed_by uuid;
begin
  select profile_b into new_confirmed_by from _consent_check_fixtures;

  begin
    update public.site_analysis_consents set confirmed_by = new_confirmed_by where id = '00000000-0000-0000-0000-0000000000a3';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: confirmed_by was modified after insert (immutability trigger did not fire), even to a VALID existing profile';
  end if;

  if err_message not like '%append-only audit log%' then
    raise exception 'BUG: confirmed_by change was rejected, but NOT by the immutability trigger (a valid profile id rules out an FK violation) — got: %', err_message;
  end if;

  raise notice 'OK: confirmed_by change to a VALID different profile still rejected by the immutability trigger, not by the FK (%)', err_message;
end $$;

-- ---- 4) revocation NULL -> timestamp -> allowed (the one permitted transition) ----
-- No exception-catching needed here: if the trigger wrongly blocked this,
-- the plain UPDATE below would raise uncaught and abort the script visibly.
update public.site_analysis_consents set revoked_at = now() where id = '00000000-0000-0000-0000-0000000000a3';
do $$
begin
  if (select revoked_at from public.site_analysis_consents where id = '00000000-0000-0000-0000-0000000000a3') is null then
    raise exception 'BUG: revocation did not take effect';
  end if;
  raise notice 'OK: NULL -> timestamp revocation allowed';
end $$;

-- ---- 5) second modification of revoked_at (timestamp -> a different timestamp) -> rejected ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    update public.site_analysis_consents set revoked_at = now() + interval '1 hour' where id = '00000000-0000-0000-0000-0000000000a3';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: revoked_at was changed a second time (timestamp -> a different timestamp)';
  end if;

  if err_message not like '%already set and cannot be changed again%' then
    raise exception 'BUG: second revoked_at change was rejected, but NOT by the immutability trigger — got: %', err_message;
  end if;

  raise notice 'OK: second revoked_at change rejected by the immutability trigger (%)', err_message;
end $$;

-- ---- 6) reactivation attempt (timestamp -> NULL) -> rejected ----
do $$
declare
  rejected boolean := false;
  err_message text;
begin
  begin
    update public.site_analysis_consents set revoked_at = null where id = '00000000-0000-0000-0000-0000000000a3';
  exception
    when others then
      rejected := true;
      err_message := sqlerrm;
  end;

  if not rejected then
    raise exception 'BUG: revocation was undone (reactivated) — revoked_at went back to NULL';
  end if;

  if err_message not like '%cannot be reset to NULL%' then
    raise exception 'BUG: reactivation was rejected, but NOT by the immutability trigger — got: %', err_message;
  end if;

  raise notice 'OK: reactivation (timestamp -> NULL) rejected by the immutability trigger (%)', err_message;
end $$;

-- ---- 7) DELETE not available via the application role ----
do $$
declare
  rejected boolean := false;
  err_state text;
  err_message text;
begin
  execute 'set local role authenticated';

  begin
    delete from public.site_analysis_consents where id = '00000000-0000-0000-0000-0000000000a3';
  exception
    when others then
      rejected := true;
      err_state := sqlstate;
      err_message := sqlerrm;
  end;

  -- Restore the original (privileged) role immediately, regardless of
  -- outcome, so every statement after this block — including the
  -- assertions right below and every later test in this script — runs
  -- with the SQL editor's original privileges again. Never leave the
  -- session running as `authenticated` past this point.
  execute 'reset role';

  if not rejected then
    raise exception 'SECURITY BUG: authenticated role was able to delete a site_analysis_consents row';
  end if;

  if err_state <> '42501' then
    raise exception 'BUG: DELETE was rejected, but not with insufficient_privilege (SQLSTATE 42501) as expected from the missing GRANT — got sqlstate=%, message=%', err_state, err_message;
  end if;

  raise notice 'OK: DELETE rejected for authenticated role with insufficient_privilege (%)', err_message;
end $$;

-- ---- 8) an old consent_version left at revoked_at IS NULL is not "active" ----
-- Uses a SECOND domain fixture, distinct from the one above: v1 and v2 are
-- inserted here WITHOUT ever revoking v1 first, so both rows genuinely
-- coexist at revoked_at IS NULL — proving the claim that a superseded
-- version can sit non-revoked indefinitely (it was never revoked, it just
-- stopped being current) and still not satisfy the app's authorization
-- check, which filters on consent_version = CURRENT_CONSENT_VERSION
-- explicitly, not on revoked_at alone.
insert into public.site_analysis_consents (hotel_id, domain, consent_version, consent_text, confirmed_by)
select '00000000-0000-0000-0000-0000000000a1', 'consent-version-check.example', 'v1', 'Consent text v1.', profile_a
from _consent_check_fixtures;

insert into public.site_analysis_consents (hotel_id, domain, consent_version, consent_text, confirmed_by)
select '00000000-0000-0000-0000-0000000000a1', 'consent-version-check.example', 'v2', 'Consent text v2.', profile_a
from _consent_check_fixtures;

do $$
declare
  non_revoked_total int;
  current_version_matches int;
begin
  select count(*) into non_revoked_total
  from public.site_analysis_consents
  where hotel_id = '00000000-0000-0000-0000-0000000000a1'
    and domain = 'consent-version-check.example'
    and revoked_at is null;

  if non_revoked_total <> 2 then
    raise exception 'BUG: expected v1 AND v2 to coexist with revoked_at IS NULL (neither was ever revoked), found % non-revoked rows', non_revoked_total;
  end if;

  -- Simulates the exact app-level authorization check
  -- (hasSiteAnalysisConsent in src/features/knowledge/actions.ts) with
  -- CURRENT_CONSENT_VERSION = 'v2'.
  select count(*) into current_version_matches
  from public.site_analysis_consents
  where hotel_id = '00000000-0000-0000-0000-0000000000a1'
    and domain = 'consent-version-check.example'
    and consent_version = 'v2'
    and revoked_at is null;

  if current_version_matches <> 1 then
    raise exception 'BUG: expected exactly 1 row to satisfy the CURRENT_CONSENT_VERSION=''v2'' authorization check, found %', current_version_matches;
  end if;

  raise notice 'OK: v1 and v2 coexist, both revoked_at IS NULL — only v2 satisfies the app''s CURRENT_CONSENT_VERSION check; v1 is simply superseded, never revoked';
end $$;

rollback;
