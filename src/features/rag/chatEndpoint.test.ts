import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "chatEndpoint.ts"), "utf8");

/**
 * Regression guards for the shared chat handler — Supabase/OpenAI-touching,
 * same testing constraint as elsewhere in this codebase (source-level
 * checks instead of a live invocation). Shared verbatim by
 * src/app/api/hotels/[id]/chat/route.ts (back-office) and
 * src/app/api/client/hotels/[id]/chat/route.ts (client portal) — each does
 * its OWN scope-explicit requireHotelAccess(hotelId, scope) check before
 * calling this, never inside this file (see its own module doc comment).
 */
describe("handleHotelChatRequest — roomRecommendation is a plain passthrough", () => {
  it("[no bolt-on] never spreads or overrides roomRecommendation — returns exactly what answerQuestion() produced", () => {
    expect(source).toMatch(/roomRecommendation:\s*result\.roomRecommendation,/);
    expect(source).not.toMatch(/\.\.\.result\.roomRecommendation/);
    expect(source).not.toMatch(/bookingUrl:\s*hotel\.booking_url/);
  });

  it("[no longer needed here] the hotel existence check no longer selects booking_url — only id, for the 404 check", () => {
    expect(source).toMatch(/\.select\("id"\)\.eq\("id", hotelId\)/);
    expect(source).not.toMatch(/\.select\("[^"]*booking_url[^"]*"\)/);
  });
});

describe("handleHotelChatRequest — authorization already done by the caller, service-role for the actual work", () => {
  it("[never authorizes itself] no requireHotelAccess/requireSuperadmin/requireClientAccess is ever AWAITED in this file — both callers already did it with their own explicit scope (the doc comment above may still name them descriptively in prose)", () => {
    expect(source).not.toMatch(/await requireHotelAccess\(|await requireSuperadmin\(|await requireClientAccess\(/);
  });

  it("[service_role, not session-bound] uses createAdminClient(), never the session-bound createClient() from lib/supabase/server — so a hotel_admin's own RLS never gates this route's actual data access", () => {
    expect(source).toMatch(/import \{ createAdminClient \} from "@\/lib\/supabase\/admin";/);
    expect(source).toMatch(/const supabase = createAdminClient\(\);/);
    expect(source).not.toMatch(/from "@\/lib\/supabase\/server"/);
  });

  it("[injected into answerQuestion] the service-role client is passed through, not left to answerQuestion's own session-bound default", () => {
    expect(source).toMatch(/answerQuestion\(\{ hotelId, conversationId, message, supabase \}\)/);
  });
});
