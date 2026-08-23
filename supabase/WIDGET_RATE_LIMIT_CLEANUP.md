# Widget rate limit — required periodic cleanup

`supabase/migrations/0006_widget_rate_limit.sql` (as fixed by `0007`/`0008`)
creates `public.widget_rate_limit_buckets`, the distributed counter table
backing the public widget's rate limiting (see
`src/features/widget/rateLimit.ts`).

## What's already handled automatically

Every call to `widget_rate_limit_try_consume()` opportunistically deletes
**its own `bucket_key`'s** stale rows before writing. A bucket that keeps
getting hit (a widget in regular use) never accumulates old rows on its
own.

## What is NOT handled automatically

A bucket that is touched and then never touched again — the common case
for a **session-level** bucket (`session:<widget_key>:<hash>`), created
once per visitor session token and typically hit only for the few minutes
of one conversation — has no later call to trigger its own cleanup. Those
rows sit in the table indefinitely unless something else removes them.

`public.widget_rate_limit_cleanup(p_older_than_seconds integer default
3600)` exists specifically for this: a plain, bounded `DELETE` of every row
older than the given age, safe to call at any time, from anywhere with
`service_role` access (same restriction as the rate-limit function itself —
`anon`/`authenticated`/`public` are all revoked). **Nothing in this
codebase calls it.** It must be run periodically, or
`widget_rate_limit_buckets` grows without bound over the life of the
deployment.

## Required operational step before prolonged production use

Schedule a periodic call to `public.widget_rate_limit_cleanup()` — for
example via Supabase's `pg_cron` extension, or any external scheduler
capable of running a SQL statement against the project (a cron hitting a
small authenticated admin endpoint, a scheduled GitHub Action, etc.).

This repository does **not** enable `pg_cron` or configure a schedule —
that's an infrastructure decision for whoever operates this Supabase
project, made deliberately, not an oversight.

**Recommended cadence:** once per hour for a busy deployment (many hotels,
high visitor volume), or once per day if traffic is light — either is safe
given the function's own default window (`p_older_than_seconds = 3600`,
i.e. it never deletes anything still inside its own rate-limit window
regardless of how often it's called). Pick based on actual row-growth
you observe, not a fixed rule; there is no harm in running it more often
than necessary.

Example (once `pg_cron` is enabled on the project, an infrastructure
decision made separately):

```sql
select cron.schedule(
  'widget-rate-limit-cleanup',
  '0 * * * *', -- hourly
  $$select public.widget_rate_limit_cleanup()$$
);
```
