import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0044_loyalty_post_stay_review.sql"), "utf8");

describe("0044_loyalty_post_stay_review.sql", () => {
  it("[additive only] touches only loyalty_settings, never any other existing table", () => {
    expect(sql).toContain("alter table public.loyalty_settings");
    expect(sql).not.toMatch(/alter table public\.(conversations|spa_bookings|hotel_partners|hotel_events|hotel_customers|customer_stays|loyalty_campaigns|loyalty_campaign_customers|loyalty_deliveries|hotel_service_requests|hotel_service_routes|hotel_service_request_events)\b/);
  });

  it("[does not touch 0037 or 0038 files]", () => {
    expect(sql).not.toContain("create table public.hotel_customers");
    expect(sql).not.toContain("create table public.customer_stays");
  });

  it("[new columns] thank_you_enabled and review_* block", () => {
    expect(sql).toContain("add column thank_you_enabled boolean not null default true");
    expect(sql).toContain("add column review_enabled boolean not null default false");
    expect(sql).toContain("add column review_content text not null default");
    expect(sql).toContain("add column review_url text");
    expect(sql).toContain("add column review_button_label text not null default");
  });

  it("[retrocompatibility] existing hotels default to thank-you enabled, review disabled — today's exact behavior", () => {
    expect(sql).toMatch(/thank_you_enabled boolean not null default true/);
    expect(sql).toMatch(/review_enabled boolean not null default false/);
  });

  it("[constraint] review_url required whenever review_enabled is true", () => {
    expect(sql).toMatch(/check \(review_enabled = false or review_url is not null\)/);
  });

  it("[constraint] at least one block must be active", () => {
    expect(sql).toMatch(/check \(thank_you_enabled or review_enabled\)/);
  });

  it("[no destructive statement] never drops or truncates existing data", () => {
    expect(sql).not.toMatch(/drop table|drop column|truncate/i);
  });
});
