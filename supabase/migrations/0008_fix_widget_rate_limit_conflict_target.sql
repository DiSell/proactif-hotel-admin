-- =========================================================================
-- Proactif System — fixes a SECOND Postgres ambiguity bug in
-- widget_rate_limit_try_consume(), surfaced only after
-- 0007_fix_widget_rate_limit_window_start.sql (already applied) fixed the
-- first one.
--
-- PROPOSED, NOT YET APPLIED. Written for review; apply it through your own
-- Supabase workflow (dashboard SQL editor / `supabase db push`) when ready
-- — nothing in this codebase executes migrations automatically.
--
-- Bug: widget_rate_limit_check.sql now fails with
--   ERROR 42702: column reference "window_start" is ambiguous
-- on the function's INSERT ... ON CONFLICT (bucket_key, window_start).
--
-- Cause: same root issue as 0007 (the function's `returns table (...,
-- window_start timestamptz, ...)` implicitly declares an OUT-parameter-like
-- identifier named window_start, visible everywhere in the function body),
-- but a DIFFERENT clause this time. `ON CONFLICT (col1, col2)` is NOT the
-- same kind of syntactic position as an INSERT's target column list
-- (`insert into t (col1, col2)`), which the SQL grammar restricts to plain
-- column names only. The ON CONFLICT target list instead accepts general
-- index elements (Postgres also allows `ON CONFLICT (expr)` to match
-- expression indexes), which makes it an expression-capable position — and
-- expression-capable positions inside a PL/pgSQL body are exactly where a
-- bare identifier gets checked against the function's own variable/OUT-
-- parameter namespace before/alongside table columns. `bucket_key` alone
-- was never ambiguous (no OUT column of that name); `window_start` in that
-- same list was, the moment 0007 stopped the DELETE from being the first
-- statement to trip over it.
--
-- Fix: replace the conflict target's column list with
-- `ON CONFLICT ON CONSTRAINT widget_rate_limit_buckets_pkey` — a
-- constraint name is a single identifier from a namespace entirely
-- separate from columns and PL/pgSQL variables, so there is no column-name
-- list left for Postgres to (mis)resolve against the function's own
-- namespace at all. widget_rate_limit_buckets_pkey is the exact,
-- automatically-generated name Postgres assigned to the table's primary
-- key (0006_widget_rate_limit.sql declares `primary key (bucket_key,
-- window_start)` inline, with no explicit `constraint <name>` clause —
-- Postgres's standard, deterministic naming convention for an unnamed
-- table constraint is `<table_name>_pkey` for a primary key).
--
-- This migration keeps 0007's DELETE fix (table aliased `as b`, both
-- columns qualified `b.bucket_key` / `b.window_start`) verbatim and
-- changes nothing else: same parameters, same RETURNS TABLE, same limits,
-- same grants/revokes (CREATE OR REPLACE FUNCTION preserves the existing
-- ownership and privileges of the function's OID — the 0006 revokes remain
-- in effect and are not repeated here), no new table.
-- =========================================================================

create or replace function public.widget_rate_limit_try_consume(
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
  --
  -- Table aliased and both columns qualified as `b.*` (fixed in 0007) —
  -- window_start alone is ambiguous against the RETURNS TABLE column of
  -- the same name; bucket_key isn't, but stays qualified for consistency.
  delete from public.widget_rate_limit_buckets as b
  where b.bucket_key = p_bucket_key
    and b.window_start < v_window_start - (p_window_seconds || ' seconds')::interval;

  -- ON CONSTRAINT instead of a (bucket_key, window_start) column list —
  -- see this migration's header comment for why the column-list form is
  -- ambiguous here specifically, unlike the INSERT's own target column
  -- list two lines above (which stays a plain column list — that position
  -- is never expression-capable, so it was never actually ambiguous).
  insert into public.widget_rate_limit_buckets (bucket_key, window_start, request_count)
  values (p_bucket_key, v_window_start, 1)
  on conflict on constraint widget_rate_limit_buckets_pkey
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
