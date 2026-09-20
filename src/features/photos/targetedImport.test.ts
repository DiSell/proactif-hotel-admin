import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "targetedImport.ts"), "utf8");

/**
 * Source-level audit for importTargetedRoomPhotos — same constraint as
 * every other Supabase-touching Server Action test in this repo: no
 * mocking infrastructure for Supabase/Next.js cookies() here, so the real
 * write path can't be exercised directly. Confirms the STRUCTURAL
 * guarantees that matter most for this chantier: no service_role writer,
 * defense-in-depth authorization, maxGuests never invented, and the exact
 * existing saveAccommodationTypes function reused rather than a second
 * implementation.
 */
describe("importTargetedRoomPhotos — authorization model", () => {
  it("[no service_role writer] never imports createAdminClient — only the session-bound createClient()", () => {
    expect(source).not.toMatch(/createAdminClient/);
    expect(source).toMatch(/import \{ createClient \} from "@\/lib\/supabase\/server";/);
  });

  it("[defense in depth] calls requireSuperadmin() itself, even though saveAccommodationTypes already does — never relies on the caller's page alone", () => {
    expect(source).toMatch(/import \{ requireSuperadmin \} from "@\/lib\/auth\/session";/);
    const fnStart = source.indexOf("export async function importTargetedRoomPhotos");
    const afterFn = source.slice(fnStart, fnStart + 300);
    expect(afterFn).toMatch(/await requireSuperadmin\(\);/);
  });

  it("[hotel-scoped] refuses any hotelId other than the one this plan targets, before touching Supabase at all", () => {
    const fnStart = source.indexOf("export async function importTargetedRoomPhotos");
    const fn = source.slice(fnStart);
    const guardIndex = fn.indexOf("if (hotelId !== LE_1837_HOTEL_ID)");
    const supabaseIndex = fn.indexOf("const supabase = await createClient();");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(supabaseIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(supabaseIndex);
    expect(fn.slice(guardIndex, guardIndex + 150)).toMatch(/return \{ ok: false, error: .*aucune action effectuée/);
  });
});

describe("importTargetedRoomPhotos — reuses saveAccommodationTypes, never reimplements the import", () => {
  it("[single writer] saveAccommodationTypes is imported from knowledge/actions and is the only call that can write room_photos — no .insert(/.upload( calls, and safeFetchBinary is never imported (only mentioned in this file's own doc comment)", () => {
    expect(source).toMatch(/import \{ saveAccommodationTypes, type SaveAccommodationTypesResult \} from "@\/features\/knowledge\/actions";/);
    expect(source).not.toMatch(/\.insert\(/);
    expect(source).not.toMatch(/\.upload\(/);
    expect(source).not.toMatch(/import.*safeFetchBinary/);
    expect(source).toMatch(/return saveAccommodationTypes\(hotelId, \{ accommodationTypes \}\);/);
  });
});

describe("importTargetedRoomPhotos — maxGuests is read fresh, never hardcoded/invented", () => {
  it("[fresh read] queries accommodation_types for max_guests before building the payload", () => {
    const fnStart = source.indexOf("export async function importTargetedRoomPhotos");
    const fn = source.slice(fnStart);
    const selectIndex = fn.indexOf('.select("id,name,source_url,max_guests")');
    const pushIndex = fn.indexOf("accommodationTypes.push({");
    expect(selectIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(selectIndex);
  });

  it("[never a literal number] maxGuests in the payload comes from the freshly-read `existing.max_guests`, never a number literal", () => {
    const pushBlock = source.slice(source.indexOf("accommodationTypes.push({"), source.indexOf("});", source.indexOf("accommodationTypes.push({")));
    expect(pushBlock).toMatch(/maxGuests: existing\.max_guests,/);
    expect(pushBlock).not.toMatch(/maxGuests: \d/);
  });

  it("[sourceUrl mismatch refuses the category] a stale/renamed source_url aborts that category rather than importing against the wrong page", () => {
    expect(source).toMatch(/if \(existing\.source_url !== category\.sourceUrl\) \{/);
  });
});

describe("importTargetedRoomPhotos — plan is the single source of truth, never duplicated here", () => {
  it("[imports the plan] reads categories/URLs from targetedImportPlan.ts, never a second literal list", () => {
    expect(source).toMatch(/import \{ LE_1837_HOTEL_ID, TARGETED_PHOTO_IMPORT_PLAN \} from "\.\/targetedImportPlan";/);
    // No inline URL literals in this file — every URL lives in targetedImportPlan.ts only.
    expect(source).not.toMatch(/https:\/\/www\.le1837\.com/);
  });

  it("[isSelected always true] every imported photo is marked selected by default — matches room_photos.is_selected's own existing default", () => {
    expect(source).toMatch(/isSelected: true,/);
  });

  it("[altText never invented] no alt text was extracted from the CSS background-image carousel — always null, never a guessed string", () => {
    expect(source).toMatch(/altText: null,/);
  });
});
