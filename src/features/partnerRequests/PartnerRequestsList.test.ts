import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PartnerRequestsList.tsx"), "utf8");

/**
 * Source-level audit, same convention as features/partners/actions.test.ts —
 * this component is "use client" and rendering it would need jsdom, which
 * this repo's vitest config doesn't enable (environment: "node" — see
 * vitest.config.mts). Behavior that IS pure (filter matching, label/tone
 * mapping) is already exhaustively tested in presentation.test.ts; this file
 * only guards the structural properties a render test would otherwise
 * check.
 */
describe("PartnerRequestsList — read-only, no PII, no mutation", () => {
  it("[no PII] never accesses .guest_phone_e164 (a doc comment may still mention the field name in prose)", () => {
    expect(source).not.toMatch(/\.guest_phone_e164/);
  });

  it("[read-only] no import from ./actions — no create/accept/reject/cancel wiring", () => {
    expect(source).not.toMatch(/from ["']\.\/actions["']/);
    expect(source).not.toMatch(/applyPartnerRequestCommand|createPartnerRequest(Backoffice|Client)/);
  });

  it("[empty state] the exact required copy is present, no fake/sample data", () => {
    expect(source).toMatch(/Vous n['’]avez encore aucune demande partenaire\./);
  });

  it("[never re-sorts] no .sort( call — trusts the query's own ORDER BY created_at desc", () => {
    expect(source).not.toMatch(/\.sort\(/);
  });

  it("[4 filters wired] renders PARTNER_REQUEST_FILTERS, not a hardcoded custom list", () => {
    expect(source).toMatch(/PARTNER_REQUEST_FILTERS/);
    expect(source).toMatch(/matchesPartnerRequestFilter/);
  });
});
