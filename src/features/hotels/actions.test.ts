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

describe("updateHotelInfo — booking_action_mode / host_booking_trigger", () => {
  function sliceFunction(exportedName: string): string {
    const start = source.indexOf(`export async function ${exportedName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport async function", start + 1);
    return source.slice(start, nextExport === -1 ? undefined : nextExport);
  }

  it("UpdateHotelInfoInput carries both fields", () => {
    const start = source.indexOf("export interface UpdateHotelInfoInput");
    const end = source.indexOf("\n}", start);
    const iface = source.slice(start, end);
    expect(iface).toMatch(/booking_action_mode: BookingActionMode;/);
    expect(iface).toMatch(/host_booking_selector: string;/);
  });

  it("[re-validated at the write path] host_booking_trigger is assembled via hostBookingTriggerSchema.parse, never a raw passthrough of the form's flat selector string", () => {
    const fn = sliceFunction("updateHotelInfo");
    expect(fn).toMatch(/hostBookingTriggerSchema\.parse\(\{\s*strategy:\s*"click",\s*selector:\s*parsed\.data\.host_booking_selector\s*\}\)/);
    expect(fn).not.toMatch(/host_booking_trigger:\s*parsed\.data\.host_booking_selector/);
  });

  it("[mode-gated] host_booking_trigger is only assembled when booking_action_mode === \"host_widget\" — null otherwise, clearing any stale selector", () => {
    const fn = sliceFunction("updateHotelInfo");
    expect(fn).toMatch(/parsed\.data\.booking_action_mode === "host_widget"\s*\n\s*\?\s*hostBookingTriggerSchema\.parse/);
  });
});

describe("deleteHotel", () => {
  function sliceFunction(exportedName: string): string {
    const start = source.indexOf(`export async function ${exportedName}`);
    expect(start).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport async function", start + 1);
    return source.slice(start, nextExport === -1 ? undefined : nextExport);
  }

  it("[requireSuperadmin first] the guard runs before any Supabase call", () => {
    const fn = sliceFunction("deleteHotel");
    const guardIndex = fn.indexOf("requireSuperadmin()");
    const deleteIndex = fn.indexOf(".delete()");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(guardIndex);
  });

  it("[deletes by id] issues .from(\"hotels\").delete().eq(\"id\", id) on the session-bound client — never the admin client", () => {
    const fn = sliceFunction("deleteHotel");
    expect(fn).toMatch(/\.from\("hotels"\)\s*\.delete\(\)\s*\.eq\("id",\s*id\)/);
    expect(fn).not.toMatch(/createAdminClient/);
  });

  it("[FK restrict violation] SQLSTATE 23503 (site_analysis_consents / reservation_audit_log audit trails) is translated into a specific, actionable message — not the generic failure", () => {
    const fn = sliceFunction("deleteHotel");
    expect(fn).toMatch(/FOREIGN_KEY_VIOLATION/);
    expect(fn).toMatch(/historique/i);
  });

  it("[success] revalidates the establishments list", () => {
    const fn = sliceFunction("deleteHotel");
    expect(fn).toMatch(/revalidatePath\("\/etablissements"\)/);
  });
});
