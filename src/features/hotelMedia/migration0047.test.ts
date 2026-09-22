import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0047_hotel_media_hotel_admin_upload.sql"), "utf8");
const sql0046 = readFileSync(join(process.cwd(), "supabase/migrations/0046_hotel_media.sql"), "utf8");

describe("0047_hotel_media_hotel_admin_upload.sql", () => {
  it("[additive only] never alters, drops, or recreates 0046's own table/policies", () => {
    expect(sql).not.toMatch(/alter table public\.hotel_media\b/);
    expect(sql).not.toMatch(/drop table.*hotel_media/i);
    expect(sql).not.toMatch(/drop policy/i);
    // 0046 itself must stay byte-for-byte unrelated to this file's concerns — this file never edits it.
    expect(sql0046).not.toContain("try_cast_uuid");
    expect(sql0046).not.toContain("hotel_admin upload own hotel-media");
  });

  it("[aucune régression room_photos / accommodation_types] ni l'un ni l'autre n'est altéré, déposé ou recréé (une mention en commentaire expliquant la non-interférence est acceptée)", () => {
    expect(sql).not.toMatch(/alter table public\.(room_photos|accommodation_types)\b/);
    expect(sql).not.toMatch(/drop table.*room_photos|drop table.*accommodation_types/i);
    expect(sql).not.toMatch(/create policy[^;]*\b(room_photos|accommodation_types)\b/);
  });

  it("[aucune dépendance sur 0045 / chatbotIdentity]", () => {
    expect(sql).not.toMatch(/hotel_customers/);
    expect(sql).not.toMatch(/chatbot_source/i);
  });

  it("[cast UUID sûr] try_cast_uuid ne laisse jamais une exception de cast remonter — elle est interceptée et renvoie NULL", () => {
    expect(sql).toMatch(/create or replace function public\.try_cast_uuid\(value text\)/);
    expect(sql).toMatch(/returns uuid/);
    expect(sql).toMatch(/exception when invalid_text_representation then\s*\n\s*return null;/);
  });

  it("[try_cast_uuid est pur] immutable, search_path épinglé, jamais SECURITY DEFINER (aucune élévation nécessaire pour un simple parsing)", () => {
    const start = sql.indexOf("create or replace function public.try_cast_uuid");
    const end = sql.indexOf("$$;", start);
    const block = sql.slice(start, end);
    expect(block).toMatch(/immutable/);
    expect(block).toMatch(/set search_path = ''/);
    expect(block).not.toMatch(/security definer/i);
  });

  it("[grants minimaux sur try_cast_uuid] authenticated seulement, jamais anon/public", () => {
    expect(sql).toMatch(/revoke all on function public\.try_cast_uuid\(text\) from public, anon;/);
    expect(sql).toMatch(/grant execute on function public\.try_cast_uuid\(text\) to authenticated;/);
  });

  it("[service_role: INSERT uniquement sur hotel_media, rien de plus]", () => {
    expect(sql).toMatch(/grant insert on public\.hotel_media to service_role;/);
    expect(sql).not.toMatch(/grant[^;]*update[^;]*on public\.hotel_media to service_role/);
    expect(sql).not.toMatch(/grant[^;]*delete[^;]*on public\.hotel_media to service_role/);
  });

  it("[storage] hotel_admin peut seulement INSERT dans hotel-media, jamais UPDATE/DELETE", () => {
    expect(sql).toMatch(/create policy "hotel_admin upload own hotel-media" on storage\.objects\s*\n\s*for insert/);
    expect(sql).not.toMatch(/create policy "hotel_admin[^"]*" on storage\.objects\s*\n\s*for (update|delete|all)/i);
  });

  it("[storage] la policy vérifie le bucket ET que le premier segment du chemin est un hotel_id autorisé via is_hotel_admin_for, sans cast brut", () => {
    const start = sql.indexOf('create policy "hotel_admin upload own hotel-media"');
    const block = sql.slice(start, start + 500);
    expect(block).toMatch(/bucket_id = 'hotel-media'/);
    expect(block).toMatch(/public\.try_cast_uuid\(\(storage\.foldername\(name\)\)\[1\]\)/);
    expect(block).toMatch(/public\.is_hotel_admin_for\(public\.try_cast_uuid\(\(storage\.foldername\(name\)\)\[1\]\)\)/);
    // Never a bare `::uuid` cast directly inside this policy's WITH CHECK.
    expect(block).not.toMatch(/\(storage\.foldername\(name\)\)\[1\]\)::uuid/);
  });

  it("[no destructive statement]", () => {
    expect(sql).not.toMatch(/drop table|drop column|truncate/i);
  });
});
