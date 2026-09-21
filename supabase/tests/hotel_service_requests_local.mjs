/**
 * Optional local PostgreSQL/WASM check, no database URL or network connection.
 * Usage: node supabase/tests/hotel_service_requests_local.mjs <absolute path to @electric-sql/pglite/dist/index.js>
 * PGlite may be installed in a temporary directory; no project dependency needed.
 * Loads actual prerequisite table/helper definitions from repository migrations.
 * Only the Supabase auth facade is simulated; this does not validate a deployed
 * Supabase instance or replay the entire migration chain (RAG/storage excluded).
 */
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath || !isAbsolute(modulePath)) throw new Error("Provide an absolute local PGlite module path.");
const { PGlite } = await import(pathToFileURL(modulePath).href);
const db = new PGlite(); // Memory only; no data directory, URL, or credentials.
const migration = (name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
function extract(source, start, end) {
  const offset = source.indexOf(start);
  const finish = source.indexOf(end, offset);
  if (offset < 0 || finish < 0) throw new Error(`Missing prerequisite: ${start}`);
  return source.slice(offset, finish + end.length);
}

try {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as
      $$ select (auth.jwt()->>'sub')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
  `);
  const initial = migration("0001_init.sql");
  const portal = migration("0011_hotel_client_portal.sql");
  for (const table of ["profiles", "hotels", "conversations"]) {
    await db.exec(extract(initial, `create table public.${table} (`, "\n);"));
  }
  await db.exec(extract(portal, "create table public.hotel_users (", "\n);"));
  await db.exec(extract(initial, "create or replace function public.set_updated_at()", "$$;"));
  await db.exec(extract(initial, "create or replace function public.is_superadmin()", "$$;"));
  await db.exec(extract(portal, "create or replace function public.is_hotel_admin_for(", "$$;"));
  await db.exec(`
    revoke all on function public.is_superadmin(), public.is_hotel_admin_for(uuid) from public;
    grant execute on function public.is_superadmin(), public.is_hotel_admin_for(uuid) to authenticated;
  `);
  const partners = migration("0020_partner_requests.sql");
  const conversationConstraint = partners.indexOf("conversations_id_hotel_id_key");
  const blockStart = partners.lastIndexOf("do $$", conversationConstraint);
  await db.exec(extract(partners.slice(blockStart), "do $$", "$$;"));
  // Mimic permissive Supabase default grants to verify 0043 explicitly revokes them.
  await db.exec(`
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  `);
  await db.exec(migration("0043_hotel_service_requests.sql"));
  const results = await db.exec(readFileSync(new URL("hotel_service_requests_check.sql", import.meta.url), "utf8"));
  const summary = results.flatMap((result) => result.rows).find((row) => "passed_assertions" in row);
  if (!summary) throw new Error("SQL checks did not return their assertion count.");
  console.log(JSON.stringify({ engine: "PGlite (local PostgreSQL)", files: 1, ...summary, failed_assertions: 0 }));
} finally {
  await db.close();
}
