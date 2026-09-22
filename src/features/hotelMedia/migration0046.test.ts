import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0046_hotel_media.sql"), "utf8");

describe("0046_hotel_media.sql", () => {
  it("[additive only] creates hotel_media, never touches an existing table", () => {
    expect(sql).toContain("create table public.hotel_media");
    expect(sql).not.toMatch(/alter table public\.(conversations|spa_bookings|hotel_partners|hotel_events|customer_stays|loyalty_settings|loyalty_campaigns|loyalty_campaign_customers|loyalty_deliveries|hotel_service_requests|hotel_service_routes|hotel_service_request_events)\b/);
  });

  it("[room_photos / accommodation_types intacts] this migration never alters, drops, or references either table's structure", () => {
    expect(sql).not.toMatch(/alter table public\.(room_photos|accommodation_types)\b/);
    expect(sql).not.toMatch(/drop table.*room_photos|drop table.*accommodation_types/i);
  });

  it("[isolation multi-hôtel] hotel_id FK references hotels, cascade on delete", () => {
    expect(sql).toMatch(/hotel_id uuid not null references public\.hotels \(id\) on delete cascade/);
  });

  it("[catégories génériques] the CHECK constraint lists the 16 generic slugs, none hotel-specific", () => {
    for (const category of ["pool", "spa", "sauna", "hammam", "jacuzzi", "fitness", "exterior", "breakfast", "restaurant", "seminar", "wedding", "chapel", "facade", "common_area", "parking", "other"]) {
      expect(sql).toContain(`'${category}'`);
    }
    expect(sql).not.toMatch(/1837|le1837/i);
  });

  it("[ordre déterministe] a position column exists, indexed alongside hotel_id/category", () => {
    expect(sql).toMatch(/position integer not null default 0/);
    expect(sql).toMatch(/create index hotel_media_hotel_category_idx on public\.hotel_media \(hotel_id, category, position\)/);
  });

  it("[plusieurs photos par catégorie] no unique constraint prevents more than one photo per (hotel_id, category) — only per (hotel_id, content_hash), for dedup", () => {
    expect(sql).not.toMatch(/unique\s*\(\s*hotel_id\s*,\s*category\s*\)/);
    expect(sql).toMatch(/constraint hotel_media_hotel_content_hash_key unique \(hotel_id, content_hash\)/);
  });

  it("[RLS] enabled, superadmin full access + hotel_admin read-only — same shape as accommodation_types/room_photos", () => {
    expect(sql).toContain("alter table public.hotel_media enable row level security");
    expect(sql).toMatch(/create policy "superadmin full access to hotel_media" on public\.hotel_media\s*\n\s*for all using \(public\.is_superadmin\(\)\) with check \(public\.is_superadmin\(\)\)/);
    expect(sql).toMatch(/create policy "hotel_admin can read own hotel_media" on public\.hotel_media\s*\n\s*for select using \(public\.is_hotel_admin_for\(hotel_id\)\)/);
  });

  it("[GRANT/REVOKE] anon has nothing; service_role limited to select+update only (no insert/delete)", () => {
    expect(sql).toContain("revoke all on public.hotel_media from anon");
    expect(sql).toMatch(/grant select, update on public\.hotel_media to service_role;/);
    expect(sql).not.toMatch(/grant[^;]*insert[^;]*on public\.hotel_media to service_role/);
    expect(sql).not.toMatch(/grant[^;]*delete[^;]*on public\.hotel_media to service_role/);
  });

  it("[storage bucket] hotel-media created, public read, superadmin-only write — same shape as hotel-room-photos/hotel-logos", () => {
    expect(sql).toMatch(/insert into storage\.buckets \(id, name, public\)\s*\nvalues \('hotel-media', 'hotel-media', true\)/);
    expect(sql).toMatch(/create policy "public read hotel-media" on storage\.objects/);
    expect(sql).toMatch(/create policy "superadmin manage hotel-media" on storage\.objects\s*\n\s*for all\s*\n\s*using \(bucket_id = 'hotel-media' and public\.is_superadmin\(\)\)/);
  });

  it("[no destructive statement]", () => {
    expect(sql).not.toMatch(/drop table|drop column|truncate/i);
  });
});
