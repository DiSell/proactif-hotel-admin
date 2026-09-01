import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Regression guards for wiring hotel_events into the prompt — same
 * source-level convention as answer.groundingMode.test.ts/
 * answerSupabaseInjection.test.ts (answerQuestion can't be unit-tested
 * directly here, no Supabase/OpenAI mocking infra in this repo).
 */
describe("answerQuestion — hotel events wiring", () => {
  it("[loaded unconditionally, every turn] never gated behind an intent flag, unlike partners — hotel events have no keyword detector", () => {
    const questionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("async function applyPartnerRequestFlow"));
    expect(questionFn).toMatch(/const events = await loadActiveHotelEvents\(supabase, hotelId, new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\);/);
  });

  it("[loaded before both branch dispatches] available to grounded AND no_context", () => {
    const questionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("async function applyPartnerRequestFlow"));
    const eventsIndex = questionFn.indexOf("const events = await loadActiveHotelEvents(");
    const groundedDispatchIndex = questionFn.indexOf('groundingMode === "grounded"');
    expect(eventsIndex).toBeGreaterThan(-1);
    expect(groundedDispatchIndex).toBeGreaterThan(eventsIndex);
  });

  it("[both answerGrounded and answerNoContext forward events to buildHotelInstructions]", () => {
    const groundedFn = source.slice(source.indexOf("async function answerGrounded"), source.indexOf("async function answerNoContext"));
    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    for (const fn of [groundedFn, noContextFn]) {
      const instructionsCall = fn.slice(fn.indexOf("buildHotelInstructions({"), fn.indexOf("});", fn.indexOf("buildHotelInstructions({")));
      expect(instructionsCall).toMatch(/events,/);
    }
  });

  it("[imports loadActiveHotelEvents from ./events] never a second/inline implementation of the selection query", () => {
    expect(source).toMatch(/import \{ loadActiveHotelEvents, type ActiveHotelEvents \} from "\.\/events";/);
  });
});
