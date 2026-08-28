import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PartnerRequestEventsTimeline.tsx"), "utf8");

describe("PartnerRequestEventsTimeline — no raw metadata, no PII, no mutation", () => {
  it("[never reads/renders event.metadata]", () => {
    expect(source).not.toMatch(/\.metadata/);
    expect(source).not.toMatch(/JSON\.stringify\(event/);
  });

  it("[no PII] never accesses .guest_phone_e164", () => {
    expect(source).not.toMatch(/\.guest_phone_e164/);
  });

  it("[read-only] no import from ./actions", () => {
    expect(source).not.toMatch(/from ["']\.\/actions["']/);
  });

  it("[uses the readable label maps, not the raw enum values]", () => {
    expect(source).toMatch(/PARTNER_REQUEST_EVENT_LABELS\[event\.event_type\]/);
    expect(source).toMatch(/PARTNER_REQUEST_ACTOR_LABELS\[event\.actor_type\]/);
  });

  it("[message shown only when present] guarded by a truthiness check, never rendered unconditionally", () => {
    expect(source).toMatch(/event\.message\s*&&/);
  });
});
