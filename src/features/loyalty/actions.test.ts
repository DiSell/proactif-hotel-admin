import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * Source-level regression guards — same convention as
 * features/client/actions.test.ts: every export here is guarded by
 * requireClientAccess() (redirect()-based), which real-invocation tests
 * can't cleanly exercise, so correctness is checked at the source level
 * instead.
 *
 * The specific bug these guard against: createCustomer/addCustomerStay used
 * to `return;` on invalid input with NO value at all — the calling form had
 * no way to know anything went wrong, and just silently did nothing.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}(`);
  expect(start).toBeGreaterThan(-1);
  const nextExport = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, nextExport === -1 ? undefined : nextExport);
}

describe("createCustomer / addCustomerStay — every failure path returns a value, never a silent no-op", () => {
  it("[createCustomer] declares an ActionResult return type and returns {ok:false, error} on invalid input", () => {
    const fn = sliceFunction("createCustomer");
    expect(source).toMatch(/export async function createCustomer\([^)]*\): Promise<ActionResult<\{ id: string \}>>/);
    expect(fn).toMatch(/if \(!parsed\.success\) return \{ ok: false, error:/);
    expect(fn).not.toMatch(/if \(!parsed\.success\) return;/);
  });

  it("[addCustomerStay] declares an ActionResult return type and returns {ok:false, error} on invalid input", () => {
    const fn = sliceFunction("addCustomerStay");
    expect(source).toMatch(/export async function addCustomerStay\([^)]*\): Promise<ActionResult<null>>/);
    expect(fn).toMatch(/if \(!parsed\.success\) return \{ ok: false, error:/);
    expect(fn).not.toMatch(/if \(!parsed\.success\) return;/);
  });

  it("[createCustomer] DB failure also returns an error, never throws past this function", () => {
    const fn = sliceFunction("createCustomer");
    expect(fn).toMatch(/if \(error \|\| !data\) return \{ ok: false, error:/);
  });

  it("[hotelId never accepted as a field on the exported input] always resolved from requireClientAccess()", () => {
    for (const name of ["createCustomer", "addCustomerStay"]) {
      const fn = sliceFunction(name);
      expect(fn).toMatch(/const \{ hotelId \} = await requireClientAccess\(\);/);
    }
  });
});

describe("every other action already returned ActionResult — unchanged shape, still true after the rewrite", () => {
  it("[updateCustomerCommunication / saveLoyaltySettings / createCampaign / cancelCampaign / importCustomersCsv all return {ok, ...}]", () => {
    for (const name of ["updateCustomerCommunication", "saveLoyaltySettings", "createCampaign", "cancelCampaign", "importCustomersCsv"]) {
      const fn = sliceFunction(name);
      expect(fn).toMatch(/return \{ ok: (true|false)/);
    }
  });
});
