import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(join(here, "../../../supabase/migrations/0005_integrations_reservations.sql"), "utf8");
// Strip comments before matching structural claims — several comments here
// deliberately discuss things the migration does NOT do (e.g. "no real
// provider connected"), which would false-positive a naive substring check
// on the raw file (same lesson as 0003/0004's migration tests).
const code = sql.replace(/--[^\n]*/g, "");

function sliceTable(startMarker: string, endMarker: string): string {
  const start = code.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = code.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return code.slice(start, end);
}

describe("0005_integrations_reservations.sql — hotel_integrations", () => {
  it("capabilities is a validated subset, never an unconstrained text[]", () => {
    const table = sliceTable("create table public.hotel_integrations", "create unique index hotel_integrations_id_hotel_id_key");
    expect(table).toMatch(/capabilities text\[\] not null default '\{\}',/);
    expect(code).toMatch(
      /constraint hotel_integrations_capabilities_valid check \(\s*capabilities <@ array\['availability','rates','booking_url','reservation_read','reservation_create','reservation_modify','reservation_cancel'\]::text\[\]\s*\)/
    );
  });

  it("[UNIQUE] is scoped to (hotel_id, provider, integration_type), NOT (hotel_id, provider) alone — the same provider brand can be connected twice for two different roles", () => {
    expect(code).toMatch(/create unique index hotel_integrations_hotel_provider_type_key on public\.hotel_integrations \(hotel_id, provider, integration_type\);/);
    expect(code).not.toMatch(/create unique index hotel_integrations_hotel_provider_key on public\.hotel_integrations \(hotel_id, provider\);/);
  });

  it("(id, hotel_id) composite unique index exists — required for every tenant-safe composite FK in this file", () => {
    expect(code).toMatch(/create unique index hotel_integrations_id_hotel_id_key on public\.hotel_integrations \(id, hotel_id\);/);
  });

  it("credential_reference is a plain nullable pointer column, never NOT NULL (no vault wired in Phase B)", () => {
    const table = sliceTable("create table public.hotel_integrations", "create unique index hotel_integrations_id_hotel_id_key");
    expect(table).toMatch(/credential_reference text,/);
    expect(table).not.toMatch(/credential_reference text not null/);
  });
});

describe("0005_integrations_reservations.sql — routing and inventory mapping", () => {
  it("[hotel_integration_capability_routes] FK is composite (integration_id, hotel_id) — routing to another hotel's integration is impossible at the Postgres level", () => {
    const table = sliceTable(
      "create table public.hotel_integration_capability_routes",
      "create index hotel_integration_capability_routes_lookup_idx"
    );
    expect(table).toMatch(
      /foreign key \(integration_id, hotel_id\) references public\.hotel_integrations \(id, hotel_id\) on delete cascade,/
    );
  });

  it("[hotel_integration_capability_routes] unique (hotel_id, capability, priority) — no ambiguous route ordering", () => {
    expect(code).toMatch(/unique \(hotel_id, capability, priority\)/);
  });

  it("[accommodation_types] does NOT re-declare accommodation_types_id_hotel_id_key — that composite unique key now lives directly in 0004_accommodation_types.sql (room_photos needs it there too), and re-declaring it here would fail with 'already exists' once 0004 is applied", () => {
    expect(code).not.toMatch(/alter table public\.accommodation_types/);
    expect(code).not.toMatch(/create unique index accommodation_types_id_hotel_id_key/);
    expect(code).not.toMatch(/drop constraint/);
  });

  it("[accommodation_inventory_mappings] both FKs are composite and tenant-safe (integration AND accommodation type)", () => {
    const table = sliceTable("create table public.accommodation_inventory_mappings", "create index accommodation_inventory_mappings_lookup_idx");
    expect(table).toMatch(/foreign key \(integration_id, hotel_id\) references public\.hotel_integrations \(id, hotel_id\) on delete cascade,/);
    expect(table).toMatch(
      /foreign key \(accommodation_type_id, hotel_id\) references public\.accommodation_types \(id, hotel_id\) on delete cascade,/
    );
  });

  it("[accommodation_inventory_mappings] a given accommodation type can map to a different external id per integration", () => {
    const table = sliceTable("create table public.accommodation_inventory_mappings", "create index accommodation_inventory_mappings_lookup_idx");
    expect(table).toMatch(/unique \(hotel_id, integration_id, accommodation_type_id\),/);
    expect(table).toMatch(/unique \(hotel_id, integration_id, external_accommodation_id\)/);
  });
});

describe("0005_integrations_reservations.sql — booking_quotes", () => {
  const table = sliceTable("create table public.booking_quotes", "create unique index booking_quotes_id_hotel_id_key");

  it("has every field the opaque quoteRef must bundle server-side", () => {
    for (const column of [
      "hotel_id uuid not null references public\\.hotels \\(id\\) on delete cascade,",
      "integration_id uuid not null,",
      "accommodation_type_id uuid not null,",
      "external_accommodation_id text not null,",
      "provider_offer_id text,",
      "check_in date not null,",
      "check_out date not null,",
      "adults integer not null,",
      "children_count integer not null default 0,",
      "children_ages integer\\[\\],",
      "rooms integer not null default 1,",
      "total_price numeric\\(12, 2\\),",
      "currency text,",
      "expires_at timestamptz,",
    ]) {
      expect(table).toMatch(new RegExp(column));
    }
  });

  it("[tenant-safe] both FKs (integration, accommodation type) are composite on (x, hotel_id)", () => {
    expect(table).toMatch(/foreign key \(integration_id, hotel_id\) references public\.hotel_integrations \(id, hotel_id\) on delete cascade,/);
    expect(table).toMatch(
      /foreign key \(accommodation_type_id, hotel_id\) references public\.accommodation_types \(id, hotel_id\) on delete cascade,/
    );
  });

  it("rejects check_out <= check_in", () => {
    expect(table).toMatch(/constraint booking_quotes_dates_order check \(check_out > check_in\)/);
  });

  it("status is constrained to the documented lifecycle, including invalidated (for PRICE_CHANGED/NO_LONGER_AVAILABLE)", () => {
    expect(table).toMatch(/status text not null default 'active' check \(status in \('active', 'consumed', 'expired', 'invalidated'\)\),/);
  });

  it("(id, hotel_id) composite unique index exists — required for reservation_operations.quote_id's tenant-safe FK", () => {
    expect(code).toMatch(/create unique index booking_quotes_id_hotel_id_key on public\.booking_quotes \(id, hotel_id\);/);
  });
});

describe("0005_integrations_reservations.sql — reservation_operations (atomic idempotency)", () => {
  const table = sliceTable("create table public.reservation_operations", "create index reservation_operations_hotel_id_idx");

  it("operation_type covers exactly create/modify/cancel — never 'get' (reads carry no idempotency risk)", () => {
    expect(table).toMatch(/operation_type text not null check \(operation_type in \('create', 'modify', 'cancel'\)\),/);
  });

  it("status covers the documented lifecycle including UNKNOWN", () => {
    expect(table).toMatch(/status text not null default 'PENDING' check \(status in \('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'\)\),/);
  });

  it("[atomic claim] the idempotency key is a real UNIQUE constraint scoped per (hotel, integration, operation_type) — the INSERT itself IS the lock, not a prior SELECT", () => {
    expect(table).toMatch(/unique \(hotel_id, integration_id, operation_type, idempotency_key\)/);
  });

  it("[integration history] FK uses ON DELETE RESTRICT, never CASCADE or SET NULL — an integration used for a reservation attempt cannot be physically deleted", () => {
    expect(table).toMatch(/foreign key \(integration_id, hotel_id\) references public\.hotel_integrations \(id, hotel_id\) on delete restrict,/);
    expect(table).not.toMatch(/integration_id, hotel_id\) references public\.hotel_integrations \(id, hotel_id\) on delete set null/);
    expect(table).not.toMatch(/integration_id, hotel_id\) references public\.hotel_integrations \(id, hotel_id\) on delete cascade/);
  });

  it("[quote history] FK to booking_quotes is also composite and RESTRICT, keeping tenant-safety on quote_id too", () => {
    expect(table).toMatch(/foreign key \(quote_id, hotel_id\) references public\.booking_quotes \(id, hotel_id\) on delete restrict,/);
  });

  it("is genuinely mutable — updated_at exists and DELETE is never granted to authenticated", () => {
    expect(table).toMatch(/updated_at timestamptz not null default now\(\),/);
    expect(code).toMatch(/grant select, insert, update on public\.reservation_operations to authenticated;/);
    expect(code).not.toMatch(/grant[^;]*delete[^;]*on public\.reservation_operations/i);
  });
});

describe("0005_integrations_reservations.sql — reservation_audit_log (append-only)", () => {
  it("has no PII column — no name/email/phone/guest", () => {
    const table = sliceTable("create table public.reservation_audit_log", "create index reservation_audit_log_hotel_id_idx");
    expect(table).not.toMatch(/\b(name|email|phone|guest)\b/i);
  });

  it("action is constrained to the four documented operations (read included, unlike reservation_operations)", () => {
    const table = sliceTable("create table public.reservation_audit_log", "create index reservation_audit_log_hotel_id_idx");
    expect(table).toMatch(/action text not null check \(action in \('create', 'get', 'modify', 'cancel'\)\),/);
  });

  it("[history] integration_id FK uses ON DELETE RESTRICT, never CASCADE or SET NULL — hotel_id (NOT NULL) can never be nulled by a composite SET NULL", () => {
    const table = sliceTable("create table public.reservation_audit_log", "create index reservation_audit_log_hotel_id_idx");
    expect(table).toMatch(/foreign key \(integration_id, hotel_id\) references public\.hotel_integrations \(id, hotel_id\) on delete restrict/);
    expect(table).not.toMatch(/on delete set null/);
    expect(table).toMatch(/integration_id uuid not null,/);
  });

  it("[history] hotel_id itself ALSO uses ON DELETE RESTRICT, not CASCADE — same precedent as site_analysis_consents (0003): deleting a hotel must never silently wipe its audit trail", () => {
    const table = sliceTable("create table public.reservation_audit_log", "create index reservation_audit_log_hotel_id_idx");
    expect(table).toMatch(/hotel_id uuid not null references public\.hotels \(id\) on delete restrict,/);
    expect(table).not.toMatch(/hotel_id uuid not null references public\.hotels \(id\) on delete cascade,/);
  });

  it("[cascade audit] reservation_audit_log is the ONLY table in this migration whose hotel_id FK is RESTRICT — every other table's hotel_id still cascades (ordinary config/ephemeral data, not a permanent audit trail)", () => {
    const restrictHotelIdCount = (code.match(/hotel_id uuid not null references public\.hotels \(id\) on delete restrict,/g) ?? []).length;
    expect(restrictHotelIdCount).toBe(1);
    const cascadeHotelIdCount = (code.match(/hotel_id uuid not null references public\.hotels \(id\) on delete cascade,/g) ?? []).length;
    // hotel_integrations, hotel_integration_capability_routes, accommodation_inventory_mappings, booking_quotes, reservation_operations.
    expect(cascadeHotelIdCount).toBe(5);
  });

  it("[no idempotency locking here] carries no unique index on idempotency_key — that lock lives entirely in reservation_operations", () => {
    expect(code).not.toMatch(/reservation_audit_log_idempotency_key_key/);
    expect(code).not.toMatch(/create unique index[^;]*on public\.reservation_audit_log/);
  });

  it("[immutability trigger] fires BEFORE UPDATE and unconditionally rejects every change", () => {
    expect(code).toMatch(/create trigger reservation_audit_log_immutable\s+before update on public\.reservation_audit_log/);
    const fn = code.slice(
      code.indexOf("create function public.enforce_reservation_audit_log_immutability"),
      code.indexOf("$$;")
    );
    expect(fn).toMatch(/raise exception/);
  });

  it("[RLS] SELECT and INSERT each have their own superadmin-gated policy — no FOR ALL", () => {
    // reservation_audit_log is the last table defined in this migration —
    // slicing to the end of the (comment-stripped) file captures its whole
    // RLS section without depending on comment text as a marker.
    const section = code.slice(code.indexOf("create table public.reservation_audit_log"));
    expect(section).not.toMatch(/for all/i);
    expect(code).toMatch(
      /create policy "superadmin can read audit log" on public\.reservation_audit_log\s+for select using \(public\.is_superadmin\(\)\);/
    );
    expect(code).toMatch(
      /create policy "superadmin can insert audit log" on public\.reservation_audit_log\s+for insert with check \(public\.is_superadmin\(\)\);/
    );
  });

  it("[no UPDATE/no DELETE] defines no UPDATE or DELETE policy, and grants only select/insert to authenticated", () => {
    expect(code).not.toMatch(/for update[^;]*reservation_audit_log/i);
    expect(code).not.toMatch(/for delete[^;]*reservation_audit_log/i);
    expect(code).toMatch(/grant select, insert on public\.reservation_audit_log to authenticated;/);
    expect(code).not.toMatch(/grant[^;]*update[^;]*on public\.reservation_audit_log/i);
    expect(code).not.toMatch(/grant[^;]*delete[^;]*on public\.reservation_audit_log/i);
  });
});

describe("0005_integrations_reservations.sql — RLS/grants across the whole file", () => {
  it("[FOR ALL count] exactly 5 tables use a superadmin FOR ALL policy (reservation_audit_log deliberately does not — it uses per-operation policies)", () => {
    const policyCount = (code.match(/for all using \(public\.is_superadmin\(\)\) with check \(public\.is_superadmin\(\)\);/g) ?? []).length;
    expect(policyCount).toBe(5);
  });

  it("[grants] every ordinary (non-audit) new table grants select/insert/update/delete to authenticated, and revokes from anon", () => {
    for (const table of ["hotel_integrations", "hotel_integration_capability_routes", "accommodation_inventory_mappings", "booking_quotes"]) {
      expect(code).toMatch(new RegExp(`grant select, insert, update, delete on public\\.${table} to authenticated;`));
      expect(code).toMatch(new RegExp(`revoke all on public\\.${table} from anon;`));
    }
  });

  it("[anon] every new table, including the two mutable/append-only reservation tables, revokes all from anon", () => {
    for (const table of ["reservation_operations", "reservation_audit_log", "booking_quotes"]) {
      expect(code).toMatch(new RegExp(`revoke all on public\\.${table} from anon;`));
    }
  });

  it("[additive only] never drops or replaces an existing table, column, function, or policy", () => {
    expect(code).not.toMatch(/drop table/i);
    expect(code).not.toMatch(/drop column/i);
    expect(code).not.toMatch(/drop policy/i);
    expect(code).not.toMatch(/create or replace/i);
  });
});
