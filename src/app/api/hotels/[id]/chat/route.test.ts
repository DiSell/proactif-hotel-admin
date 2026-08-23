import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "route.ts"), "utf8");

/**
 * Regression guards for the admin chat route — Supabase/OpenAI-touching,
 * same testing constraint as elsewhere in this codebase (source-level
 * checks instead of a live invocation). bookingUrl is now sourced entirely
 * inside answerQuestion() (see features/rag/answer.ts,
 * answer.roomRecommendation.test.ts) — this route no longer knows anything
 * about it.
 */
describe("POST /api/hotels/[id]/chat — roomRecommendation is a plain passthrough", () => {
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
