import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0048_hotel_service_request_handover_sms.sql"), "utf8");

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — PHASE 1, CODE + TESTS ONLY. This
 * migration is created locally only; nothing in this repo applies it
 * automatically, and this test never connects to any database — it only
 * pins the SQL file's own text.
 */
describe("0048_hotel_service_request_handover_sms.sql", () => {
  it("[additive columns only] never drops or truncates anything", () => {
    expect(sql).not.toMatch(/drop table|drop column|truncate/i);
  });

  it("[0043 untouched] never redefines require_service_request_hotel_user, create_hotel_service_request, or apply_hotel_service_request_command", () => {
    expect(sql).not.toMatch(/create (or replace )?function public\.require_service_request_hotel_user/);
    expect(sql).not.toMatch(/create (or replace )?function public\.create_hotel_service_request\(/);
    expect(sql).not.toMatch(/create (or replace )?function public\.apply_hotel_service_request_command/);
  });

  it("[guest_phone_e164 added to hotel_service_requests, nullable, E.164-checked]", () => {
    expect(sql).toMatch(/alter table public\.hotel_service_requests\s+add column guest_phone_e164 text check \(guest_phone_e164 is null or guest_phone_e164 ~/);
  });

  it("[3 independent, nullable SMS number columns on chatbot_settings, distinct from handoff_phone]", () => {
    expect(sql).toMatch(/add column handover_sms_phone_primary text check/);
    expect(sql).toMatch(/add column handover_sms_phone_secondary text check/);
    expect(sql).toMatch(/add column handover_sms_phone_backup text check/);
    expect(sql).not.toMatch(/alter column handoff_phone/);
  });

  it("[guest-safe RPC hardcodes kind/category/priority — never caller-selected]", () => {
    const fnStart = sql.indexOf("create function public.create_hotel_service_request_from_widget");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart, sql.indexOf("$$;", fnStart));
    expect(fnBody).toMatch(/'handover', 'reception', 'normal', 'open'/);
    expect(fnBody).not.toMatch(/p_kind|p_category|p_priority|p_status/);
  });

  it("[guest-safe RPC never calls require_service_request_hotel_user]", () => {
    const fnStart = sql.indexOf("create function public.create_hotel_service_request_from_widget");
    const fnBody = sql.slice(fnStart, sql.indexOf("$$;", fnStart));
    expect(fnBody).not.toMatch(/require_service_request_hotel_user/);
  });

  it("[guest-safe RPC granted to service_role only, never anon/authenticated]", () => {
    expect(sql).toMatch(
      /revoke all on function public\.create_hotel_service_request_from_widget\(uuid, uuid, text, text, text\)\s+from public, anon, authenticated, service_role;/
    );
    expect(sql).toMatch(/grant execute on function public\.create_hotel_service_request_from_widget\(uuid, uuid, text, text, text\) to service_role;/);
  });

  it("[sms_attempts table: no direct writes for anyone, only the recorder function writes]", () => {
    expect(sql).toMatch(
      /revoke all on public\.hotel_service_request_sms_attempts from public, anon, authenticated, service_role;/
    );
    expect(sql).toMatch(/grant select on public\.hotel_service_request_sms_attempts to authenticated;/);
  });

  it("[sms attempt recorder granted to service_role only]", () => {
    expect(sql).toMatch(
      /revoke all on function public\.record_hotel_service_request_sms_attempt\(uuid, uuid, text, text\)\s+from public, anon, authenticated, service_role;/
    );
    expect(sql).toMatch(/grant execute on function public\.record_hotel_service_request_sms_attempt\(uuid, uuid, text, text\) to service_role;/);
  });

  it("[sms attempt status constrained to sent/failed/unknown — never stores Twilio SIDs or secrets]", () => {
    expect(sql).toMatch(/status text not null check \(status in \('sent', 'failed', 'unknown'\)\)/);
    expect(sql).not.toMatch(/sid|auth_token|account_sid/i);
  });

  it("[RLS enabled on the new table, read-only for authorized hotel staff]", () => {
    expect(sql).toMatch(/alter table public\.hotel_service_request_sms_attempts enable row level security;/);
    expect(sql).toMatch(/for select to authenticated using \(public\.is_superadmin\(\) or public\.is_hotel_admin_for\(hotel_id\)\)/);
  });
});
