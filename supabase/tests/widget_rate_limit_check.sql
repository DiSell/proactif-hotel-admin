-- Constraint/behavior checks for 0006_widget_rate_limit.sql — run this in
-- the Supabase SQL editor (or psql connected to the project) AFTER that
-- migration has been applied.
--
-- Nothing here can be proven by vitest (no Postgres in this repo's test
-- runner). This script actually calls widget_rate_limit_try_consume()
-- repeatedly and checks its real allow/deny decisions, including across a
-- real window boundary (via pg_sleep — this script takes a couple of
-- seconds to run, on purpose, rather than manipulating window_start
-- directly, so it proves the actual time-bucketing logic).
--
-- No fixtures needed: widget_rate_limit_buckets has no FK to hotels or
-- anything else — bucket_key is an opaque string. Everything this script
-- writes is rolled back at the end.

begin;

-- ---- 1) allowed under the limit, denied at the limit ----
do $$
declare
  r record;
  i integer;
begin
  for i in 1..3 loop
    select * into r from public.widget_rate_limit_try_consume('test-bucket-a', 60, 3);
    if not r.allowed then
      raise exception 'BUG: request % of 3 was denied, should have been allowed (max_requests=3)', i;
    end if;
    if r.current_count <> i then
      raise exception 'BUG: expected current_count=% on request %, got %', i, i, r.current_count;
    end if;
  end loop;

  select * into r from public.widget_rate_limit_try_consume('test-bucket-a', 60, 3);
  if r.allowed then
    raise exception 'BUG: 4th request was allowed despite max_requests=3';
  end if;
  if r.retry_after_seconds <= 0 then
    raise exception 'BUG: a denied request should report a positive retry_after_seconds, got %', r.retry_after_seconds;
  end if;

  raise notice 'OK: allowed exactly 3 requests, denied the 4th, for bucket test-bucket-a (retry_after_seconds=%)', r.retry_after_seconds;
end $$;

-- ---- 2) bucket isolation — a different bucket_key has its own independent counter ----
do $$
declare
  r record;
begin
  select * into r from public.widget_rate_limit_try_consume('test-bucket-b', 60, 1);
  if not r.allowed then
    raise exception 'BUG: a fresh, independent bucket (test-bucket-b) was denied on its first request — bucket isolation broken (leaking count from test-bucket-a)';
  end if;
  raise notice 'OK: test-bucket-b independent from test-bucket-a (allowed on first request despite test-bucket-a already being exhausted)';
end $$;

-- ---- 3) global vs session bucket-key prefixes never collide ----
do $$
declare
  r record;
begin
  select * into r from public.widget_rate_limit_try_consume('widget:ps_live_demo', 60, 1);
  if not r.allowed then
    raise exception 'BUG: widget: prefixed bucket denied on first request';
  end if;

  select * into r from public.widget_rate_limit_try_consume('session:ps_live_demo:abc123', 60, 1);
  if not r.allowed then
    raise exception 'BUG: session: prefixed bucket denied on first request — should be entirely independent of the widget: bucket sharing the same widget_key substring';
  end if;

  raise notice 'OK: widget:<key> and session:<key>:<hash> bucket keys never collide, even sharing the same widget_key substring';
end $$;

-- ---- 4) window expiration — a request in a NEW window is allowed again ----
do $$
declare
  r record;
  i integer;
begin
  for i in 1..2 loop
    select * into r from public.widget_rate_limit_try_consume('test-bucket-window', 2, 2);
    if not r.allowed then
      raise exception 'BUG: request % of 2 was denied within the first 2-second window (max_requests=2)', i;
    end if;
  end loop;

  select * into r from public.widget_rate_limit_try_consume('test-bucket-window', 2, 2);
  if r.allowed then
    raise exception 'BUG: 3rd request within the same 2-second window was allowed despite max_requests=2';
  end if;

  perform pg_sleep(2.2);

  select * into r from public.widget_rate_limit_try_consume('test-bucket-window', 2, 2);
  if not r.allowed then
    raise exception 'BUG: a request in a NEW window (after waiting past window_seconds) was still denied — window expiration is broken';
  end if;

  raise notice 'OK: a new window resets the counter — request allowed again after waiting past window_seconds';
end $$;

-- ---- 5) anon/authenticated cannot call the function directly (server/service-role only) ----
do $$
declare
  rejected boolean := false;
  err_state text;
  err_message text;
begin
  execute 'set local role authenticated';

  begin
    perform public.widget_rate_limit_try_consume('should-not-be-reachable', 60, 1);
  exception
    when others then
      rejected := true;
      err_state := sqlstate;
      err_message := sqlerrm;
  end;

  execute 'reset role';

  if not rejected then
    raise exception 'SECURITY BUG: authenticated role was able to call widget_rate_limit_try_consume directly';
  end if;
  if err_state <> '42501' then
    raise exception 'BUG: call was rejected, but not with insufficient_privilege (SQLSTATE 42501) as expected from the missing GRANT — got sqlstate=%, message=%', err_state, err_message;
  end if;

  raise notice 'OK: authenticated role cannot call widget_rate_limit_try_consume — insufficient_privilege (%)', err_message;
end $$;

-- ---- 6) invalid parameters are rejected loudly, never silently treated as "allowed" ----
do $$
declare
  rejected boolean := false;
begin
  begin
    perform public.widget_rate_limit_try_consume('', 60, 1);
  exception
    when others then
      rejected := true;
  end;
  if not rejected then
    raise exception 'BUG: an empty bucket_key was accepted instead of rejected';
  end if;
  raise notice 'OK: empty bucket_key rejected';
end $$;

rollback;
