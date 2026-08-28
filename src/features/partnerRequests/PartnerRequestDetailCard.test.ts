import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PartnerRequestDetailCard.tsx"), "utf8");

describe("PartnerRequestDetailCard — read-only, no PII, no mutation", () => {
  it("[no PII] never accesses .guest_phone_e164 — no safe, dedicated PII detail query exists yet (see final report)", () => {
    expect(source).not.toMatch(/\.guest_phone_e164/);
  });

  it("[read-only] no import from ./actions", () => {
    expect(source).not.toMatch(/from ["']\.\/actions["']/);
    expect(source).not.toMatch(/applyPartnerRequestCommand|createPartnerRequest(Backoffice|Client)/);
  });

  it("[required fields present] partner name, category, date, time, party size, guest name, details, status, partner response, responded_at", () => {
    for (const field of [
      "partnerName",
      "request.request_category",
      "request.requested_date",
      "request.requested_time",
      "request.party_size",
      "request.guest_name",
      "request.details",
      "request.status",
      "request.partner_response",
      "request.responded_at",
    ]) {
      expect(source).toContain(field);
    }
  });
});
