import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "../../../supabase/migrations/0003_site_analysis_consent.sql"), "utf8");
// Comments in this file deliberately discuss DELETE/FOR ALL/etc. while
// explaining why they're absent (e.g. "no DELETE policy"), which would
// false-positive a naive substring/regex check on the raw file. Structural
// assertions run against the comment-stripped SQL instead.
const code = sql.replace(/--[^\n]*/g, "");

/**
 * Regression guards for the SQL migration itself. Nothing here can prove
 * the trigger actually rejects a write at runtime — that requires a real
 * Postgres (see supabase/tests/site_analysis_consent_check.sql, run
 * manually after the migration is applied). This file only guards the
 * *shape* of the migration text so a future edit can't silently drop one
 * of these guarantees without a test noticing.
 */
describe("0003_site_analysis_consent.sql — audit-log guarantees", () => {
  it("[no DELETE] grants select/insert/update only, never delete, to authenticated", () => {
    expect(code).toMatch(/grant select, insert, update on public\.site_analysis_consents to authenticated;/);
    expect(code).not.toMatch(/grant[^;]*delete/i);
  });

  it("[no DELETE] defines no DELETE policy", () => {
    expect(code).not.toMatch(/for delete/i);
  });

  it("[no DELETE] defines no FOR ALL policy (each operation is scoped explicitly)", () => {
    expect(code).not.toMatch(/for all/i);
  });

  it("[RLS] SELECT, INSERT and UPDATE each have their own superadmin-gated policy", () => {
    expect(code).toMatch(/create policy "superadmin can read consents" on public\.site_analysis_consents\s+for select using \(public\.is_superadmin\(\)\);/);
    expect(code).toMatch(/create policy "superadmin can insert consents" on public\.site_analysis_consents\s+for insert with check \(public\.is_superadmin\(\)\);/);
    expect(code).toMatch(/create policy "superadmin can update consents" on public\.site_analysis_consents\s+for update using \(public\.is_superadmin\(\)\) with check \(public\.is_superadmin\(\)\);/);
  });

  it("[immutability trigger] fires BEFORE UPDATE on the table", () => {
    expect(code).toMatch(/create trigger site_analysis_consents_immutable\s+before update on public\.site_analysis_consents/);
  });

  it("[immutability trigger] rejects a change to any column other than revoked_at", () => {
    const fn = code.slice(code.indexOf("create function public.enforce_site_analysis_consent_immutability"));
    for (const column of ["hotel_id", "domain", "consent_version", "consent_text", "confirmed_by", "confirmed_at", "created_at"]) {
      expect(fn).toMatch(new RegExp(`new\\.${column} is distinct from old\\.${column}`));
    }
  });

  it("[immutability trigger] rejects reactivation (timestamp -> NULL)", () => {
    const fn = code.slice(code.indexOf("create function public.enforce_site_analysis_consent_immutability"));
    expect(fn).toMatch(/old\.revoked_at is not null and new\.revoked_at is null/);
  });

  it("[immutability trigger] rejects re-revocation (timestamp A -> timestamp B)", () => {
    const fn = code.slice(code.indexOf("create function public.enforce_site_analysis_consent_immutability"));
    expect(fn).toMatch(/elsif old\.revoked_at is not null then/);
  });

  it("[immutability trigger] does not reject the one allowed transition (NULL -> timestamp)", () => {
    const fn = code.slice(
      code.indexOf("create function public.enforce_site_analysis_consent_immutability"),
      code.indexOf("$$;")
    );
    // The only two `raise exception` branches guard reactivation and
    // re-revocation; neither condition is true when old.revoked_at is NULL
    // and new.revoked_at is a timestamp, so that branch falls through to
    // `return new;` implicitly. Assert there are exactly two revoked_at
    // exception branches (not three, which would mean NULL -> timestamp
    // got blocked too).
    const revokedAtExceptions = fn.match(/raise exception\s*\n?\s*'site_analysis_consents\.revoked_at/g) ?? [];
    expect(revokedAtExceptions.length).toBe(2);
  });

  it("[hotel_id FK] uses ON DELETE RESTRICT, not CASCADE", () => {
    expect(code).toMatch(/hotel_id uuid not null references public\.hotels \(id\) on delete restrict,/);
  });

  it("[confirmed_by FK] uses ON DELETE RESTRICT", () => {
    expect(code).toMatch(/confirmed_by uuid not null references public\.profiles \(id\) on delete restrict,/);
  });

  it("[domain CHECK] rejects empty string, a scheme, a slash, and whitespace", () => {
    const check = code.slice(code.indexOf("constraint site_analysis_consents_domain_shape"), code.indexOf("create index"));
    expect(check).toContain("domain <> ''");
    expect(check).toContain("domain !~ '://'");
    expect(check).toContain("domain !~ '/'");
    expect(check).toContain("domain !~ '\\s'");
  });

  it("[history] the partial unique index on (hotel_id, domain, consent_version) is preserved", () => {
    expect(code).toMatch(
      /create unique index site_analysis_consents_active_key\s+on public\.site_analysis_consents \(hotel_id, domain, consent_version\)\s+where revoked_at is null;/
    );
  });
});
