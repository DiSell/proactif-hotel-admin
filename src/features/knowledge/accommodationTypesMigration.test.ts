import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "../../../supabase/migrations/0004_accommodation_types.sql"), "utf8");
// Strip comments before matching structural claims — several comments here
// deliberately discuss things the migration does NOT do (e.g. "capacity is
// never invented"), which would false-positive a naive substring check on
// the raw file (same lesson as 0003's consent migration test).
const code = sql.replace(/--[^\n]*/g, "");

describe("0004_accommodation_types.sql", () => {
  it("[accommodation_types] has nullable capacity columns, never NOT NULL", () => {
    const table = code.slice(code.indexOf("create table public.accommodation_types"), code.indexOf("create index accommodation_types_hotel_id_idx"));
    expect(table).toMatch(/max_guests integer,/);
    expect(table).toMatch(/max_adults integer,/);
    expect(table).toMatch(/max_children integer,/);
    expect(table).not.toMatch(/max_guests integer not null/);
    expect(table).not.toMatch(/max_adults integer not null/);
    expect(table).not.toMatch(/max_children integer not null/);
  });

  it("[accommodation_types] hotel_id cascades on hotel deletion", () => {
    expect(code).toMatch(/hotel_id uuid not null references public\.hotels \(id\) on delete cascade,\s*name text not null,/);
  });

  it("[accommodation_types] (id, hotel_id) composite unique index exists — required for room_photos' tenant-safe composite FK", () => {
    expect(code).toMatch(/create unique index accommodation_types_id_hotel_id_key on public\.accommodation_types \(id, hotel_id\);/);
  });

  it("[room_photos] links to accommodation_types by a stable, tenant-safe COMPOSITE FK — never a single-column accommodation_type_id reference, never a free-text name column", () => {
    const table = code.slice(code.indexOf("create table public.room_photos"), code.indexOf("create unique index room_photos_hotel_content_hash_key"));
    expect(table).toMatch(/foreign key \(accommodation_type_id, hotel_id\) references public\.accommodation_types \(id, hotel_id\) on delete cascade/);
    expect(table).not.toMatch(/accommodation_type_id uuid not null references public\.accommodation_types \(id\) on delete cascade,/);
    expect(table).not.toMatch(/room_type_name/);
  });

  it("[room_photos] keeps source_page_url, source_image_url, storage_path and photo_url distinct", () => {
    const table = code.slice(code.indexOf("create table public.room_photos"), code.indexOf("create unique index room_photos_hotel_content_hash_key"));
    expect(table).toMatch(/source_page_url text,/);
    expect(table).toMatch(/source_image_url text not null,/);
    expect(table).toMatch(/storage_path text not null,/);
    expect(table).toMatch(/photo_url text not null,/);
  });

  it("[room_photos] deduplicates by (hotel_id, content_hash), not by URL alone", () => {
    expect(code).toMatch(/create unique index room_photos_hotel_content_hash_key\s+on public\.room_photos \(hotel_id, content_hash\);/);
  });

  it("[RLS] both tables use FOR ALL (ordinary content, not an audit log)", () => {
    const policyCount = (code.match(/for all using \(public\.is_superadmin\(\)\) with check \(public\.is_superadmin\(\)\);/g) ?? []).length;
    expect(policyCount).toBe(2);
  });

  it("[grants] both tables grant select/insert/update/delete to authenticated, and revoke from anon", () => {
    expect(code).toMatch(/grant select, insert, update, delete on public\.accommodation_types to authenticated;/);
    expect(code).toMatch(/grant select, insert, update, delete on public\.room_photos to authenticated;/);
    expect(code).toMatch(/revoke all on public\.accommodation_types from anon;/);
    expect(code).toMatch(/revoke all on public\.room_photos from anon;/);
  });

  it("[storage] creates a public hotel-room-photos bucket with public-read / superadmin-write policies", () => {
    expect(code).toMatch(/insert into storage\.buckets \(id, name, public\)\s*values \('hotel-room-photos', 'hotel-room-photos', true\)/);
    expect(code).toMatch(/create policy "public read hotel-room-photos" on storage\.objects\s*for select\s*using \(bucket_id = 'hotel-room-photos'\);/);
    expect(code).toMatch(
      /create policy "superadmin manage hotel-room-photos" on storage\.objects\s*for all\s*using \(bucket_id = 'hotel-room-photos' and public\.is_superadmin\(\)\)\s*with check \(bucket_id = 'hotel-room-photos' and public\.is_superadmin\(\)\);/
    );
  });
});
