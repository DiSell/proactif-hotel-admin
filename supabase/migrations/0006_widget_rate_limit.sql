-- =========================================================================
-- Proactif System — distributed rate limiting for the public widget.
--
-- Additive only — no change to any existing table, column, function, or
-- policy from 0001_init.sql through 0005_integrations_reservations.sql.
--
-- PROPOSED, NOT YET APPLIED. Written for review; apply it through your own
-- Supabase workflow (dashboard SQL editor / `supabase db push`) when ready
-- — nothing in this codebase executes migrations automatically.
--
-- Replaces the in-memory, single-process rate limiter that previously
-- guarded POST /api/widget/[widgetKey]/chat (src/features/widget/rateLimit.ts)
-- — that implementation could not share counters across server instances,
-- which matters specifically because widget_key is a PUBLIC identifier
-- (visible in the embed snippet on any page that uses it) and every chat
-- request triggers a real, billed OpenAI call. This table + function are
-- the shared counter every instance reads and writes atomically.
-- =========================================================================

-- =========================================================================
-- widget_rate_limit_buckets
-- =========================================================================
-- One row per (bucket_key, window_start) — a fixed-window counter, not a
-- true sliding window. Deliberate, documented tradeoff: a fixed window can
-- allow up to ~2x the configured limit across a window boundary (e.g. a
-- burst just before :00 and another just after), but it's atomic, cheap,
-- and race-free with a single INSERT ... ON CONFLICT ... DO UPDATE — no
-- SELECT-then-write anywhere. Good enough for a cost-abuse backstop; not
-- claimed to be precise-to-the-request throttling.
--
-- bucket_key is an opaque, application-defined string — this table has no
-- opinion on what it identifies. The application (see
-- src/features/widget/rateLimit.ts) uses two disjoint prefixes so the two
-- required quota levels can never collide with each other:
--   'widget:<widget_key>'              — global, per hotel, cost backstop
--   'session:<widget_key>:<sha256>'    — per visitor session token hash
-- No FK to hotels/widget_key on purpose: a bucket_key is a rate-limit
-- identity, not a business entity, and must keep working even if the
-- widget_key it references is later rotated or the hotel deleted.
create table public.widget_rate_limit_buckets (
  bucket_key text not null,
  window_start timestamptz not null,
  request_count integer not null default 0,
  primary key (bucket_key, window_start)
);

-- Supports both the cleanup function below and the opportunistic per-bucket
-- cleanup inside widget_rate_limit_try_consume.
create index widget_rate_limit_buckets_window_start_idx on public.widget_rate_limit_buckets (window_start);

alter table public.widget_rate_limit_buckets enable row level security;
-- Deliberately NO policy at all — not even a superadmin one. This table is
-- never meant to be read or written through PostgREST by any role; only
-- the service-role client (which bypasses RLS entirely, same as every
-- other public-widget query — see src/features/widget/publicHotel.ts) ever
-- touches it, exclusively through the function below.
revoke all on public.widget_rate_limit_buckets from anon;
revoke all on public.widget_rate_limit_buckets from authenticated;

-- =========================================================================
-- widget_rate_limit_try_consume — the ONLY place a rate-limit decision is
-- made. Atomic: the INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING is a
-- single statement, so concurrent callers (any number of server instances)
-- can never both read the same pre-increment count and both decide
-- "allowed" — Postgres serializes the row-level write. No SELECT-then-write
-- anywhere in this function.
--
-- Limits (window_seconds, max_requests) are NOT hardcoded here — they are
-- passed in by the caller on every call, so the actual numbers live in one
-- documented place in application code (see WIDGET_GLOBAL_RATE_LIMIT /
-- WIDGET_SESSION_RATE_LIMIT in src/features/widget/rateLimit.ts), not
-- duplicated or silently drifting between SQL and TypeScript.
--
-- Includes an opportunistic cleanup of this bucket_key's own stale rows on
-- every call (bounded by the composite PK index, typically 0-1 rows) so an
-- individual bucket never grows without limit even without an external
-- scheduler. widget_rate_limit_cleanup() below additionally exists for a
-- periodic global sweep (see the migration's own header / the deployment
-- notes this ships with) — not wired to a scheduler by this migration.
-- =========================================================================
create function public.widget_rate_limit_try_consume(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_requests integer
)
returns table (allowed boolean, current_count integer, window_start timestamptz, retry_after_seconds integer)
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_count integer;
begin
  if p_bucket_key is null or length(p_bucket_key) = 0 then
    raise exception 'widget_rate_limit_try_consume: p_bucket_key is required';
  end if;
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'widget_rate_limit_try_consume: p_window_seconds must be positive';
  end if;
  if p_max_requests is null or p_max_requests <= 0 then
    raise exception 'widget_rate_limit_try_consume: p_max_requests must be positive';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);

  -- Opportunistic, bounded cleanup for THIS bucket_key only — cheap (hits
  -- the composite PK index, normally deletes 0-1 old rows since a bucket
  -- has at most one row per window it was ever called in).
  delete from public.widget_rate_limit_buckets
  where bucket_key = p_bucket_key
    and window_start < v_window_start - (p_window_seconds || ' seconds')::interval;

  insert into public.widget_rate_limit_buckets (bucket_key, window_start, request_count)
  values (p_bucket_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set request_count = widget_rate_limit_buckets.request_count + 1
  returning widget_rate_limit_buckets.request_count into v_count;

  return query select
    (v_count <= p_max_requests) as allowed,
    v_count as current_count,
    v_window_start as window_start,
    case
      when v_count <= p_max_requests then 0
      else greatest(0, ceil(p_window_seconds - extract(epoch from v_now - v_window_start)))::integer
    end as retry_after_seconds;
end;
$$;

-- Server-only, matching every other public-widget query in this codebase:
-- callers use the service-role client (src/lib/supabase/admin.ts), which
-- bypasses grants/RLS entirely and needs none of these. The revokes below
-- are the defensive backstop — no role reachable through PostgREST
-- (anon/authenticated) may ever call this directly.
revoke all on function public.widget_rate_limit_try_consume(text, integer, integer) from public;
revoke all on function public.widget_rate_limit_try_consume(text, integer, integer) from anon;
revoke all on function public.widget_rate_limit_try_consume(text, integer, integer) from authenticated;

-- =========================================================================
-- widget_rate_limit_cleanup — optional periodic global sweep.
-- =========================================================================
-- Not called by any application code path and not wired to a scheduler by
-- this migration (adding pg_cron or an external scheduled job is an
-- operational decision, deliberately left out of this task's scope). The
-- per-bucket cleanup inside widget_rate_limit_try_consume above already
-- keeps any bucket that's still being actively hit from growing without
-- bound; this function is for buckets that simply stop being used
-- entirely (e.g. a widget_key rotated or a hotel deactivated) and would
-- otherwise sit in the table forever. Safe to run manually or from a
-- future cron at any cadence — a plain bounded DELETE, nothing clever.
create function public.widget_rate_limit_cleanup(p_older_than_seconds integer default 3600)
returns integer
language plpgsql
as $$
declare
  v_deleted integer;
begin
  delete from public.widget_rate_limit_buckets
  where window_start < clock_timestamp() - (p_older_than_seconds || ' seconds')::interval;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.widget_rate_limit_cleanup(integer) from public;
revoke all on function public.widget_rate_limit_cleanup(integer) from anon;
revoke all on function public.widget_rate_limit_cleanup(integer) from authenticated;
