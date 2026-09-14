-- Proactif System — fixes a starvation bug in the post-stay follow-up
-- worker (features/loyalty/worker.ts, 0037_customer_loyalty.sql): the
-- "stays due for a follow-up" query had no way to exclude a stay that was
-- already attempted, and no explicit ordering — it relied solely on the
-- unique constraint on loyalty_deliveries(hotel_id, idempotency_key) to
-- silently skip re-attempts. Once the number of already-attempted stays
-- past their cutoff exceeded the query's own row cap, arbitrary Postgres
-- ordering meant genuinely NEW due stays could be starved indefinitely —
-- the query kept re-fetching the same already-handled rows forever.
--
-- Additive only. No existing table, policy, function or workflow is changed.

alter table public.customer_stays
  add column loyalty_delivery_queued_at timestamptz;

comment on column public.customer_stays.loyalty_delivery_queued_at is
  'Set once, the first time a post-stay follow-up delivery was ever reserved for this stay (features/loyalty/worker.ts::reserveAndSend) — regardless of whether that delivery ultimately sent, failed, or was skipped as ineligible. Lets the due-stays query permanently exclude an already-attempted stay instead of re-fetching it (and wasting its row-limit budget on it) on every single cron run.';

create index customer_stays_pending_followup_idx
  on public.customer_stays (hotel_id, status, check_out)
  where loyalty_delivery_queued_at is null;
