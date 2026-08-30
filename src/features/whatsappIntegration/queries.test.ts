import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Source-level only, matching this repo's own established convention for
 * this exact shape of file — features/hotels/queries.ts::getHotel and
 * features/widget/queries.ts::getWidgetSettings (the two closest
 * precedents this query mirrors) have no dedicated test files of their
 * own either; requireSuperadmin()/requireClientAccess()'s own
 * authorization behavior is already exhaustively covered at runtime in
 * src/lib/auth/session.test.ts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "queries.ts"), "utf8");

function sliceFunction(name: string): string {
  const start = source.indexOf(`async function ${name}`);
  expect(start).toBeGreaterThan(-1);
  const nextFn = source.indexOf("\nasync function", start + 1);
  const nextExport = source.indexOf("\nexport const", start + 1);
  const boundaries = [nextFn, nextExport].filter((i) => i !== -1);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : undefined;
  return source.slice(start, end);
}

describe("queryHotelWhatsAppConnection (shared body)", () => {
  it("[scoped to the given hotelId] never returns another hotel's connection", () => {
    expect(source).toMatch(/\.eq\("hotel_id", hotelId\)/);
  });

  it("[never reads hotel_whatsapp_connection_secrets] this query only ever touches the non-secret metadata table", () => {
    expect(source).not.toMatch(/hotel_whatsapp_connection_secrets/);
  });
});

describe("getHotelWhatsAppConnection (admin)", () => {
  it("[admin-only] calls requireSuperadmin() before reading the shared query body — same guard as features/widget/queries.ts::getWidgetSettings", () => {
    const fn = sliceFunction("fetchHotelWhatsAppConnection(");
    const requireIndex = fn.indexOf("await requireSuperadmin();");
    const queryIndex = fn.indexOf("queryHotelWhatsAppConnection(");
    expect(requireIndex).toBeGreaterThan(-1);
    expect(queryIndex).toBeGreaterThan(requireIndex);
  });

  it("[deduped via React cache(), same convention as getHotel/getWidgetSettings]", () => {
    expect(source).toMatch(/export const getHotelWhatsAppConnection = cache\(fetchHotelWhatsAppConnection\);/);
  });
});

describe("getHotelWhatsAppConnectionForClient (client portal)", () => {
  it("[hotelId comes EXCLUSIVELY from requireClientAccess()] never a parameter — this function takes none", () => {
    const fn = sliceFunction("fetchHotelWhatsAppConnectionForClient");
    expect(fn).toMatch(/async function fetchHotelWhatsAppConnectionForClient\(\): Promise/);
    expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
  });

  it("[queries via createClientPortalClient()] not the back-office createClient() — RLS evaluates under the client-portal session", () => {
    const fn = sliceFunction("fetchHotelWhatsAppConnectionForClient");
    expect(fn).toMatch(/await createClientPortalClient\(\)/);
  });

  it("[requireClientAccess() called before the shared query body]", () => {
    const fn = sliceFunction("fetchHotelWhatsAppConnectionForClient");
    const requireIndex = fn.indexOf("await requireClientAccess();");
    const queryIndex = fn.indexOf("queryHotelWhatsAppConnection(");
    expect(requireIndex).toBeGreaterThan(-1);
    expect(queryIndex).toBeGreaterThan(requireIndex);
  });

  it("[deduped via React cache()]", () => {
    expect(source).toMatch(/export const getHotelWhatsAppConnectionForClient = cache\(fetchHotelWhatsAppConnectionForClient\);/);
  });
});
