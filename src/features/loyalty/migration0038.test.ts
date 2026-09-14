import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0038_customer_loyalty_stay_tracking.sql"), "utf8");

describe("0038_customer_loyalty_stay_tracking.sql", () => {
  it("[additive only] touches only customer_stays, never any other existing table", () => {
    expect(sql).toContain("alter table public.customer_stays");
    expect(sql).not.toMatch(/alter table public\.(conversations|spa_bookings|hotel_partners|hotel_events|hotel_customers|loyalty_campaigns|loyalty_deliveries)\b/);
  });

  it("[new column] loyalty_delivery_queued_at, nullable timestamptz", () => {
    expect(sql).toContain("add column loyalty_delivery_queued_at timestamptz");
  });

  it("[partial index supports the due-query filter] indexed where the column is still null", () => {
    expect(sql).toMatch(/create index customer_stays_pending_followup_idx[\s\S]*where loyalty_delivery_queued_at is null/);
  });
});
