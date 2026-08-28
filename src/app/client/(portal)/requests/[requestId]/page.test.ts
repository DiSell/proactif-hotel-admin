import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "page.tsx"), "utf8");

describe("client/requests/[requestId] page — route protection, tenant scoping, read-only", () => {
  it("[route protected] calls requireClientAccess()", () => {
    expect(source).toMatch(/await requireClientAccess\(\)/);
  });

  it("[tenant-scoped reads] getPartnerRequestById/listPartnerRequestEvents are both called with hotelId AND requestId", () => {
    expect(source).toMatch(/getPartnerRequestById\(hotelId, requestId, supabase\)/);
    expect(source).toMatch(/listPartnerRequestEvents\(hotelId, requestId, supabase\)/);
  });

  it("[not found, not an error] an unknown/foreign-tenant requestId resolves to notFound(), never a thrown error or a distinguishable message", () => {
    expect(source).toMatch(/if \(!request\) notFound\(\)/);
  });

  it("[client-portal client] uses createClientPortalClient, never createAdminClient", () => {
    expect(source).toMatch(/createClientPortalClient/);
    expect(source).not.toMatch(/createAdminClient/);
  });

  it("[no mutation] no import from features/partnerRequests/actions", () => {
    expect(source).not.toMatch(/partnerRequests\/actions/);
  });

  it("[no PII] never accesses .guest_phone_e164", () => {
    expect(source).not.toMatch(/\.guest_phone_e164/);
  });
});
