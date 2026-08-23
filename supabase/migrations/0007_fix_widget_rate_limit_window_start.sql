-- =========================================================================
-- Proactif System — fixes a Postgres ambiguity bug in
-- widget_rate_limit_try_consume(), introduced in
-- 0006_widget_rate_limit.sql (already applied).
--
-- PROPOSED, NOT YET APPLIED. Written for review; apply it through your own
-- Supabase workflow (dashboard SQL editor / `supabase db push`) when ready
-- — nothing in this codebase executes migrations automatically.
--
-- Bug: widget_rate_limit_check.sql fails immediately with
--   ERROR 42702: column reference "window_start" is ambiguous
-- on the function's opportunistic cleanup DELETE.
--
-- Cause: the function is declared `returns table (allowed boolean,
-- current_count integer, window_start timestamptz, retry_after_seconds
-- integer)`. PL/pgSQL implicitly declares each of those RETURNS TABLE
-- columns as an OUT-parameter-like identifier, visible throughout the
-- function body — including one literally named `window_start`, the exact
-- same name as widget_rate_limit_buckets.window_start. Any bare
-- (unqualified) `window_start` reference inside the function body is
-- therefore ambiguous between "the table column" and "the output
-- parameter", and Postgres refuses to guess.
--
-- This migration replaces ONLY that one function, via CREATE OR REPLACE
-- FUNCTION, with the exact same signature, parameter names, and logic —
-- the sole change is qualifying the table in the DELETE's WHERE clause so
-- `window_start` there can only mean the table column. No other statement
-- in the function was found to be ambiguous (see the accompanying report):
-- every other bare `bucket_key`/`window_start`/`request_count` reference
-- either has no naming collision at all, is already explicitly qualified
-- (`widget_rate_limit_buckets.request_count`), or sits in a SQL position
-- (INSERT's target column list, the ON CONFLICT target, a SET target, or a
-- SELECT alias with no FROM clause at all) where PL/pgSQL variable
-- shadowing cannot occur by the SQL grammar itself.
--
-- CREATE OR REPLACE FUNCTION preserves the function's existing ownership
-- and grants/revokes (per Postgres semantics) — the revoke all ... from
-- public/anon/authenticated already applied by 0006 remain in effect
-- unchanged and are deliberately not repeated here. No table, no grant, no
-- limit, no rate-limiting logic changes — this migration touches nothing
-- except the one ambiguous identifier.
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
  -- Table aliased and both columns qualified as `b.*` — window_start alone
  -- is ambiguous here (see this migration's header comment); bucket_key
  -- isn't, but is qualified too for consistency and to make this
  -- statement's intent unambiguous to a future reader as well as to
  -- Postgres.
  delete from public.widget_rate_limit_buckets as b
  where b.bucket_key = p_bucket_key
    and b.window_start < v_window_start - (p_window_seconds || ' seconds')::interval;

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
