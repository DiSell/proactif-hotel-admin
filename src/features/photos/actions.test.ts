import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * Regression guards for the client/superadmin photo-selection actions —
 * Supabase-touching (requireHotelAccess + createAdminClient) AND
 * revalidatePath-calling, which throws "Invariant: static generation store
 * missing" outside a real Next.js request context — same testing
 * constraint as every other Server Action in this repo that calls
 * revalidatePath (see src/features/knowledge/actions.test.ts), checked at
 * the source level only, no real invocation. requireHotelAccess itself
 * (superadmin-any-hotel vs hotel_admin-own-hotel-only) is already
 * exhaustively covered at runtime in src/lib/auth/session.test.ts — not
 * re-tested here.
 *
 * `scope` is NEVER a parameter of any EXPORTED function in this file — same
 * discipline as features/partners/actions.test.ts (see that file's own doc
 * comment for the full reasoning): a client component (PhotosManager.tsx)
 * must never be able to supply or influence which cookie scope a shared
 * action reads. Every exported action is a thin, hardcoded-scope wrapper
 * around a non-exported `*Internal` function.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  // Bounded by whichever comes first: the next exported wrapper, or the
  // next non-exported `*Internal` helper.
  const nextExport = source.indexOf("\nexport async function", start + 1);
  const nextInternal = source.indexOf("\nasync function", start + 1);
  const boundaries = [nextExport, nextInternal].filter((i) => i !== -1);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : undefined;
  return source.slice(start, end);
}

const EXPORTED_FUNCTION_NAMES = [
  "setPhotoSelectionBackoffice",
  "setPhotoSelectionClient",
  "setAccommodationPhotosSelectionBackoffice",
  "setAccommodationPhotosSelectionClient",
];

describe("no exported action ever accepts a scope parameter", () => {
  it("[signature audit] none of the exported functions declares a `scope` parameter", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      const fn = sliceFunction(name);
      const signatureEnd = fn.indexOf("Promise<");
      const signature = fn.slice(0, signatureEnd);
      expect(signature).not.toMatch(/scope/i);
    }
  });

  it("[no AuthScope import surfaces on an exported function]", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      expect(sliceFunction(name)).not.toMatch(/AuthScope/);
    }
  });
});

describe("setPhotoSelectionBackoffice / setPhotoSelectionClient", () => {
  it("[hardcoded scope, no fallback] Backoffice always passes \"backoffice\", Client always passes \"client\" — never received from a caller", () => {
    expect(source).toMatch(/setPhotoSelectionInternal\(hotelId, photoId, isSelected, "backoffice"\)/);
    expect(source).toMatch(/setPhotoSelectionInternal\(hotelId, photoId, isSelected, "client"\)/);
  });

  it("[both roles authorized] guarded by requireHotelAccess — allows superadmin (any hotel) OR the linked hotel_admin, never requireClientAccess/requireSuperadmin alone", () => {
    expect(source).toMatch(/requireHotelAccess\(hotelId, scope\)/);
  });

  it("[tenant isolation] scopes the update by BOTH photo id and hotel_id — a guessed photoId from another hotel can never be touched", () => {
    expect(source).toMatch(/\.eq\("id", photoId\)\.eq\("hotel_id", hotelId\)/);
  });

  it("[writes is_selected only] the update payload is exactly { is_selected: isSelected }", () => {
    expect(source).toMatch(/\.update\(\{ is_selected: isSelected \}\)/);
  });

  it("[service_role, not session-bound] uses createAdminClient() after requireHotelAccess, never the client requireHotelAccess itself resolves", () => {
    expect(source).toMatch(/const supabase = createAdminClient\(\);/);
  });
});

describe("setAccommodationPhotosSelectionBackoffice / setAccommodationPhotosSelectionClient", () => {
  it("[hardcoded scope, no fallback]", () => {
    expect(source).toMatch(/setAccommodationPhotosSelectionInternal\(hotelId, accommodationTypeId, isSelected, "backoffice"\)/);
    expect(source).toMatch(/setAccommodationPhotosSelectionInternal\(hotelId, accommodationTypeId, isSelected, "client"\)/);
  });

  it("[both roles authorized] guarded by requireHotelAccess", () => {
    expect(source).toMatch(/requireHotelAccess\(hotelId, scope\)/);
  });

  it("[tenant isolation] scopes the bulk update by BOTH hotel_id and accommodation_type_id", () => {
    expect(source).toMatch(/\.eq\("hotel_id", hotelId\)/);
    expect(source).toMatch(/\.eq\("accommodation_type_id", accommodationTypeId\)/);
  });
});
