import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Regression guard for a real production incident: listHotelEvents()
 * throwing (e.g. migration 0032_hotel_events.sql not yet applied on a
 * given environment) previously crashed this ENTIRE page — including the
 * already-working ChatbotPersonalizationForm above it — because the call
 * was awaited with no try/catch. Source-level only (no jsdom in this
 * repo's vitest config, same convention as every other Server Component in
 * this codebase).
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "page.tsx"), "utf8");

describe("ClientChatbotPage — listHotelEvents failure never crashes the whole page", () => {
  it("[wrapped in try/catch] a query failure degrades to an empty events list, never an unhandled throw", () => {
    const callIndex = source.indexOf("listHotelEvents(chatbotData.hotelId");
    expect(callIndex).toBeGreaterThan(-1);
    const tryIndex = source.lastIndexOf("try {", callIndex);
    const catchIndex = source.indexOf("} catch", callIndex);
    expect(tryIndex).toBeGreaterThan(-1);
    expect(catchIndex).toBeGreaterThan(callIndex);
    const catchBlock = source.slice(catchIndex, source.indexOf("const assistantName", catchIndex));
    expect(catchBlock).toMatch(/events = \[\];/);
  });

  it("[failure is logged, not swallowed silently]", () => {
    const catchIndex = source.indexOf("} catch");
    const catchBlock = source.slice(catchIndex, catchIndex + 300);
    expect(catchBlock).toMatch(/console\.error\(/);
  });
});
