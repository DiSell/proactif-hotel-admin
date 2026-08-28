import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "page.tsx"), "utf8");

/**
 * Source-level audit — Next.js server-component pages aren't unit-rendered
 * anywhere in this repo (no page.tsx test exists elsewhere either); this
 * mirrors the readFileSync-based regex convention already used for Server
 * Actions (features/partners/actions.test.ts) and applies it here instead.
 */
describe("client/requests page — route protection, tenant scoping, read-only", () => {
  it("[route protected] calls requireClientAccess()", () => {
    expect(source).toMatch(/await requireClientAccess\(\)/);
  });

  it("[hotelId used] listPartnerRequestsForHotel is called with the resolved hotelId, not a hardcoded/guessed value", () => {
    expect(source).toMatch(/listPartnerRequestsForHotel\(hotelId, supabase\)/);
  });

  it("[client-portal client] uses createClientPortalClient, never createAdminClient/a back-office client", () => {
    expect(source).toMatch(/createClientPortalClient/);
    expect(source).not.toMatch(/createAdminClient/);
  });

  it("[no mutation] no import from features/partnerRequests/actions", () => {
    expect(source).not.toMatch(/partnerRequests\/actions/);
  });

  it("[no extra ad hoc read] the only partnerRequests query used here is listPartnerRequestsForHotel — no direct .from(\"partner_requests\") call", () => {
    expect(source).not.toMatch(/\.from\("partner_requests/);
  });
});
