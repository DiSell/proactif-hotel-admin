import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "route.ts"), "utf8");

/**
 * Regression guards for the admin chat route — Supabase/OpenAI-touching,
 * same testing constraint as elsewhere in this codebase (source-level
 * checks instead of a live invocation).
 */
describe("POST /api/hotels/[id]/chat — roomRecommendation", () => {
  it("bookingUrl comes from the hotel row already loaded, never from the model's output", () => {
    expect(source).toMatch(/select\("id, booking_url"\)/);
    expect(source).toMatch(/bookingUrl:\s*hotel\.booking_url/);
  });

  it("roomRecommendation is null when answerQuestion didn't produce one — never a half-built object", () => {
    expect(source).toMatch(/result\.roomRecommendation \? \{ \.\.\.result\.roomRecommendation, bookingUrl: hotel\.booking_url \} : null/);
  });
});
