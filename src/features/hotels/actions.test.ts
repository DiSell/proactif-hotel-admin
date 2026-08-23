import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * updateHotelInfo is Supabase-touching (requireSuperadmin + createClient),
 * same testing constraint as other server actions in this repo (see
 * src/features/knowledge/actions.test.ts) — checked at the source level.
 * Runtime validation behavior (accept/reject a given URL) is covered
 * separately in schema.test.ts, which has no Supabase dependency.
 */
describe("updateHotelInfo — booking_url / spa_booking_url", () => {
  function sliceFunction(exportedName: string): string {
    const start = source.indexOf(`export async function ${exportedName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport async function", start + 1);
    return source.slice(start, nextExport === -1 ? undefined : nextExport);
  }

  it("UpdateHotelInfoInput carries both fields", () => {
    const start = source.indexOf("export interface UpdateHotelInfoInput");
    const end = source.indexOf("}", start);
    const iface = source.slice(start, end);
    expect(iface).toMatch(/booking_url: string;/);
    expect(iface).toMatch(/spa_booking_url: string;/);
  });

  it("[save] the update() call writes both booking_url and spa_booking_url", () => {
    const fn = sliceFunction("updateHotelInfo");
    expect(fn).toMatch(/booking_url:\s*parsed\.data\.booking_url \|\| null,/);
    expect(fn).toMatch(/spa_booking_url:\s*parsed\.data\.spa_booking_url \|\| null,/);
  });

  it("[empty -> null] an empty string is saved as null, never as an empty string, for both fields", () => {
    const fn = sliceFunction("updateHotelInfo");
    // Rules out a bare passthrough (`booking_url: parsed.data.booking_url,`)
    // that would persist "" instead of null.
    expect(fn).not.toMatch(/booking_url:\s*parsed\.data\.booking_url,/);
    expect(fn).not.toMatch(/spa_booking_url:\s*parsed\.data\.spa_booking_url,/);
  });

  it("[validated input] updateHotelInfo parses through updateHotelInfoSchema before writing anything, never the raw input", () => {
    const fn = sliceFunction("updateHotelInfo");
    expect(fn).toMatch(/updateHotelInfoSchema\.safeParse\(input\)/);
    // Everything written to Supabase comes from parsed.data, not the raw `input` param.
    expect(fn).not.toMatch(/\.update\(\{[^}]*\binput\.(booking_url|spa_booking_url)\b/);
  });
});
