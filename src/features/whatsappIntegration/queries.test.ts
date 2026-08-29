import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level only, matching this repo's own established convention for
 * this exact shape of file — features/hotels/queries.ts::getHotel and
 * features/widget/queries.ts::getWidgetSettings (the two closest
 * precedents this query mirrors) have no dedicated test files of their
 * own either; requireSuperadmin()'s own authorization behavior is already
 * exhaustively covered at runtime in src/lib/auth/session.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "queries.ts"), "utf8");

describe("getHotelWhatsAppConnection", () => {
  it("[admin-only] calls requireSuperadmin() before any data access — same guard as features/widget/queries.ts::getWidgetSettings", () => {
    const fnStart = source.indexOf("async function fetchHotelWhatsAppConnection");
    const fn = source.slice(fnStart);
    const requireIndex = fn.indexOf("await requireSuperadmin();");
    const fromIndex = fn.indexOf('.from("hotel_whatsapp_connections")');
    expect(requireIndex).toBeGreaterThan(-1);
    expect(fromIndex).toBeGreaterThan(requireIndex);
  });

  it("[scoped to the given hotelId] never returns another hotel's connection", () => {
    expect(source).toMatch(/\.eq\("hotel_id", hotelId\)/);
  });

  it("[never reads hotel_whatsapp_connection_secrets] this query only ever touches the non-secret metadata table", () => {
    expect(source).not.toMatch(/hotel_whatsapp_connection_secrets/);
  });

  it("[deduped via React cache(), same convention as getHotel/getWidgetSettings]", () => {
    expect(source).toMatch(/export const getHotelWhatsAppConnection = cache\(fetchHotelWhatsAppConnection\);/);
  });
});
