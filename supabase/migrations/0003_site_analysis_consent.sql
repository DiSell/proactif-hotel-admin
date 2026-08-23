-- =========================================================================
-- Proactif System — Jalon 3 : consentement explicite avant l'analyse
-- automatique du site web d'un établissement (features/crawler/).
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql / 0002_rag.sql.
--
-- PROPOSED, NOT YET APPLIED. Written for review; apply it through your own
-- Supabase workflow (dashboard SQL editor / `supabase db push`) when ready
-- — nothing in this codebase executes migrations automatically.
--
-- This revision hardens the audit-log guarantees at the Postgres level
-- rather than trusting the application alone:
--   - no role the app runs as can DELETE a row (no grant, no policy);
--   - a BEFORE UPDATE trigger makes every column except revoked_at
--     physically immutable after insert, and allows revoked_at exactly one
--     transition (NULL -> a timestamp) — so a bug in actions.ts cannot
--     rewrite history even if it tried to.
-- =========================================================================

-- =========================================================================
-- site_analysis_consents
-- =========================================================================
-- An append-only audit log, not a single mutable "current consent" row:
-- every confirmation is INSERTed as its own permanent record. The only
-- column that can ever change afterwards is revoked_at, and only once, from
-- NULL to a timestamp — enforced below by a trigger, not just by
-- convention. This is deliberate: a future change to the consent wording
-- (a new consent_version) must never silently erase what an earlier
-- version actually said, and a revoked authorization must remain provable
-- after the fact, not disappear.
--
-- consent_text stores the EXACT wording shown at confirmed_at, not just a
-- version label — the version alone wouldn't survive a copy edit made
-- without bumping it, and a compliance question ("what exactly did they
-- agree to on this date?") needs the literal text, not just a pointer to
-- code that may since have changed.
--
-- Scoped to the domain alone: it never authorizes any other domain, and it
-- is a permission gate only — it never overrides robots.txt or the SSRF
-- guard, both of which the crawler still enforces on every run regardless
-- of what's recorded here. The route additionally verifies the analyzed
-- URL belongs to the establishment's own hotels.website domain before ever
-- reaching this table (see src/app/api/hotels/[id]/analyze/route.ts) — this
-- table records permission for a domain the app has already confirmed is
-- the hotel's own, it does not itself decide that.
create table public.site_analysis_consents (
  id uuid primary key default gen_random_uuid(),
  -- ON DELETE RESTRICT, not CASCADE (unlike every other hotel_id FK in this
  -- schema): this table exists specifically so consent history survives
  -- independently of whatever else happens to the hotel. RESTRICT means a
  -- hotel with any consent history — active or revoked — cannot be
  -- physically deleted until that history is dealt with explicitly. No
  -- feature in this codebase deletes a hotel today (grep confirms no
  -- `.from("hotels").delete()` anywhere), so this introduces no behavior
  -- change now; it only matters if hotel deletion is added later, at which
  -- point it should force a deliberate decision (archive/export the
  -- history first) rather than silently discarding it via cascade. The
  -- alternative — hotel_id nullable with ON DELETE SET NULL — would keep
  -- the rows but sever them from the hotel they document, which defeats
  -- the point of an audit trail meant to answer "did hotel X authorize
  -- domain Y". RESTRICT was the user's stated preference and there is no
  -- conflicting requirement in the current codebase, so it is kept as-is.
  hotel_id uuid not null references public.hotels (id) on delete restrict,
  -- Bare domain only (no scheme, no path, no port, "www." stripped) — e.g.
  -- "le1837.com". Never a wildcard. The CHECK below is a cheap defensive
  -- backstop against obviously-wrong values reaching this table by
  -- accident (empty string, a full URL, a path, whitespace) — it is not a
  -- DNS/hostname validator. The real normalization and validation happen
  -- server-side, in the same urlPolicy.ts the crawler itself uses (see
  -- src/app/api/hotels/[id]/analyze/route.ts) — this CHECK exists purely
  -- so a bug upstream fails loudly at the database instead of silently
  -- storing garbage in an audit log.
  domain text not null,
  -- Identifies which wording confirmed_at's consent_text is. Bump the
  -- app's CURRENT_CONSENT_VERSION whenever the copy changes; an older
  -- version's row then simply stops satisfying the "is this hotel/domain
  -- currently authorized" check (see below) without needing to touch this
  -- row at all — it stays exactly as it was confirmed, and may well remain
  -- revoked_at IS NULL forever (it was never revoked, it just isn't the
  -- current version anymore). That is expected, not a bug: "authorized"
  -- always means "matches CURRENT_CONSENT_VERSION AND revoked_at IS NULL",
  -- checked explicitly by the app on every read — never inferred from
  -- revoked_at alone.
  consent_version text not null,
  -- The exact text the admin agreed to — a verbatim copy, not a reference.
  consent_text text not null,
  -- ON DELETE RESTRICT (unchanged from the prior revision, kept
  -- deliberately): a profile that has ever confirmed a site-analysis
  -- consent cannot be physically deleted — the same audit-trail reasoning
  -- as hotel_id above applies to "who confirmed this" as much as to
  -- "for which hotel". No feature in this codebase deletes a profile
  -- today, so this changes no current behavior; it is documented here so
  -- a future profile-deletion feature has to handle this on purpose
  -- instead of hitting a surprise FK violation in production.
  confirmed_by uuid not null references public.profiles (id) on delete restrict,
  confirmed_at timestamptz not null default now(),
  -- NULL = still active. The ONLY column this table ever lets you change
  -- after insert, and the ONLY transition allowed is NULL -> a timestamp
  -- (revocation), enforced by the trigger below — never timestamp -> NULL
  -- (undoing a revocation) and never timestamp -> a different timestamp.
  -- The row remains as a permanent record that authorization existed from
  -- confirmed_at until revoked_at.
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint site_analysis_consents_domain_shape check (
    domain <> ''
    and domain !~ '://'
    and domain !~ '/'
    and domain !~ '\s'
  )
);

create index site_analysis_consents_hotel_id_idx on public.site_analysis_consents (hotel_id);

-- The "is this hotel/domain currently authorized" check the app runs
-- (hotel_id + domain + CURRENT_CONSENT_VERSION + revoked_at is null) reads
-- straight off this index. It also doubles as a data-integrity guarantee:
-- at most one ACTIVE (non-revoked) row per (hotel, domain, version) — no
-- accidental duplicate authorizations for the exact same wording. It does
-- NOT prevent multiple rows across different versions, or a fresh row
-- after a revocation: both are exactly the history this table exists to
-- keep. A partial index, not a plain UNIQUE constraint, is what makes that
-- possible — a plain `unique (hotel_id, domain)` would block re-consenting
-- after a revocation and would force overwriting history on every version
-- bump, which is exactly what this migration is designed to avoid.
--
-- Note: a row from a superseded consent_version can sit at revoked_at IS
-- NULL indefinitely — it was never revoked, it simply stopped being the
-- current version. That does not make it "active" in any functional sense:
-- the app always checks consent_version = CURRENT_CONSENT_VERSION
-- explicitly alongside revoked_at IS NULL, so an old version never
-- satisfies the authorization check regardless of its revoked_at value.
create unique index site_analysis_consents_active_key
  on public.site_analysis_consents (hotel_id, domain, consent_version)
  where revoked_at is null;

-- =========================================================================
-- Immutability trigger — makes the audit-log guarantee a physical one.
-- =========================================================================
-- Everything except revoked_at is frozen the moment a row is inserted, and
-- revoked_at itself may only move NULL -> a timestamp, exactly once. Any
-- other UPDATE — including a re-revocation, an attempted "un-revoke", or a
-- change to any other column — is rejected with an explicit error. This
-- means even a bug in actions.ts (e.g. an accidental .update() touching
-- consent_text, or a well-meaning "fix a typo" admin script) cannot rewrite
-- history; it can only fail loudly.
create function public.enforce_site_analysis_consent_immutability()
returns trigger
language plpgsql
as $$
begin
  if new.hotel_id is distinct from old.hotel_id
    or new.domain is distinct from old.domain
    or new.consent_version is distinct from old.consent_version
    or new.consent_text is distinct from old.consent_text
    or new.confirmed_by is distinct from old.confirmed_by
    or new.confirmed_at is distinct from old.confirmed_at
    or new.created_at is distinct from old.created_at
  then
    raise exception
      'site_analysis_consents is an append-only audit log: hotel_id, domain, consent_version, consent_text, confirmed_by, confirmed_at and created_at cannot be changed after insert (row id=%)',
      old.id;
  end if;

  if old.revoked_at is distinct from new.revoked_at then
    if old.revoked_at is not null and new.revoked_at is null then
      raise exception
        'site_analysis_consents.revoked_at cannot be reset to NULL: revocation is permanent and cannot be undone (row id=%)',
        old.id;
    elsif old.revoked_at is not null then
      raise exception
        'site_analysis_consents.revoked_at is already set and cannot be changed again once revoked (row id=%)',
        old.id;
    end if;
    -- else: old.revoked_at was NULL and new.revoked_at is a timestamp —
    -- the one and only allowed transition (a fresh revocation).
  end if;

  return new;
end;
$$;

create trigger site_analysis_consents_immutable
  before update on public.site_analysis_consents
  for each row
  execute function public.enforce_site_analysis_consent_immutability();

-- =========================================================================
-- Row Level Security — narrow, per-operation policies (not FOR ALL): the
-- table only ever needs SELECT/INSERT/UPDATE from the app, and DELETE is
-- deliberately not grantable to any policy at all, not even to a
-- superadmin — see the grants below. UPDATE is further constrained in
-- practice by the trigger above, which is the real enforcement point;
-- the policy only gates *who* may attempt an update, not *what* update is
-- allowed.
-- =========================================================================
alter table public.site_analysis_consents enable row level security;

create policy "superadmin can read consents" on public.site_analysis_consents
  for select using (public.is_superadmin());

create policy "superadmin can insert consents" on public.site_analysis_consents
  for insert with check (public.is_superadmin());

create policy "superadmin can update consents" on public.site_analysis_consents
  for update using (public.is_superadmin()) with check (public.is_superadmin());

-- No DELETE policy: even a superadmin cannot delete a row through the
-- normal application role. Revocation is the only supported way to end a
-- consent's validity, and it is done with UPDATE ... SET revoked_at, never
-- DELETE. No server action in this codebase issues
-- .from("site_analysis_consents").delete(...), and none should be added.

-- =========================================================================
-- Data API grants
-- =========================================================================
-- No DELETE here, matching the absence of a DELETE policy above: the
-- `authenticated` role (the only role the app's Server Actions run
-- queries as — see src/lib/supabase/server.ts) can never delete a row from
-- this table, by grant as well as by policy.
grant select, insert, update on public.site_analysis_consents to authenticated;
revoke all on public.site_analysis_consents from anon;
