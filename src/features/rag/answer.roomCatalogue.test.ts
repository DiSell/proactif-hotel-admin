import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterAndRankAccommodations, shouldAskPartySizeOnly, type AccommodationCandidate } from "./accommodationRanking";
import type { PartySize } from "./partySize";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * CHANTIER — ROOM DISCOVERY CATALOGUE 5/7. Root cause, reproduced and
 * confirmed by live diagnostic against Le 1837's real knowledge base: for a
 * bare "2" reply continuing a room-discovery flow, retrieveKnowledgeHybrid's
 * own hybrid similarity/lexical scoring for that low-signal query happened
 * to keep chunks for 5 of the 7 capacity-compatible categories and drop the
 * other 2 (uneven real-world content density per accommodation page), and
 * the model's free-text catalogue reply mirrored that same uneven RAG
 * coverage instead of enumerating the full deterministic candidate list
 * buildAccommodationGuidance had already named to it. Fix: a new
 * RoomCatalogueEntry[] structured field, computed directly from
 * rankedCandidates (already the exact, capacity-AND-availability-filtered
 * list — see accommodationRanking.ts/applyAvailabilityToCandidates),
 * independent of groundingMode and of whatever the model chooses to say in
 * prose — mirrors RoomRecommendation's own "server computes truth, model
 * narrates around it" precedent, never a new state machine, never a
 * rewrite of ROOM_DISCOVERY's own intent/continuation logic.
 */

const LE_1837_CANDIDATES: AccommodationCandidate[] = [
  { id: "mini-suite-id", name: "Mini-suite", maxGuests: 2, maxAdults: null, maxChildren: null },
  { id: "standard-id", name: "Standard", maxGuests: 2, maxAdults: null, maxChildren: null },
  { id: "superior-id", name: "Superior", maxGuests: 4, maxAdults: null, maxChildren: null },
  { id: "deluxe-id", name: "Deluxe", maxGuests: 4, maxAdults: null, maxChildren: null },
  { id: "deluxe-pmr-id", name: "Deluxe PMR", maxGuests: 4, maxAdults: null, maxChildren: null },
  { id: "junior-suite-id", name: "Junior Suite", maxGuests: 6, maxAdults: null, maxChildren: null },
  { id: "junior-pmr-id", name: "Junior PMR", maxGuests: 6, maxAdults: null, maxChildren: null },
];

describe("shouldAskPartySizeOnly — single source of truth shared by prompt.ts and answer.ts", () => {
  it("[no room-discovery intent] never asks, regardless of party/mentions", () => {
    expect(shouldAskPartySizeOnly(false, false, { adults: null, children: null, total: null })).toBe(false);
  });

  it("[precise accommodation already named] never asks even with an unknown party and live discovery intent", () => {
    expect(shouldAskPartySizeOnly(true, true, { adults: null, children: null, total: null })).toBe(false);
  });

  it("[party already known] never asks", () => {
    expect(shouldAskPartySizeOnly(true, false, { adults: null, children: null, total: 2 })).toBe(false);
  });

  it("[the exact CAS 1 gate] discovery intent live, no precise mention, party unknown -> asks", () => {
    expect(shouldAskPartySizeOnly(true, false, { adults: null, children: null, total: null })).toBe(true);
  });
});

/**
 * CAS 1/2/3 — proven against Le 1837's REAL capacities (pulled from
 * production during this chantier's diagnostic): Mini-suite/Standard=2,
 * Superior/Deluxe/Deluxe PMR=4, Junior Suite/Junior PMR=6. Exercises the
 * exact same filterAndRankAccommodations already used everywhere else in
 * this codebase (never a new filtering mechanism) — the roomCatalogue field
 * is a direct, unconditional map over its output (see the source-level
 * wiring tests below), so proving filterAndRankAccommodations's own output
 * here is equivalent to proving the catalogue's contents.
 */
describe("CAS 1/2 — party of 2 at Le 1837: all 7 categories are capacity-compatible", () => {
  const party: PartySize = { adults: null, children: null, total: 2 };
  const ranked = filterAndRankAccommodations(LE_1837_CANDIDATES, party);

  it("all 7 candidates survive the capacity filter for a party of 2", () => {
    expect(ranked).toHaveLength(7);
    expect(new Set(ranked.map((c) => c.name))).toEqual(
      new Set(["Mini-suite", "Standard", "Superior", "Deluxe", "Deluxe PMR", "Junior Suite", "Junior PMR"])
    );
  });

  it("[the exact reported bug] Junior Suite and Junior PMR are present — never silently dropped", () => {
    const names = ranked.map((c) => c.name);
    expect(names).toContain("Junior Suite");
    expect(names).toContain("Junior PMR");
  });
});

describe("CAS 3 — party of 6 at Le 1837: only Junior Suite + Junior PMR are capacity-compatible", () => {
  const party: PartySize = { adults: null, children: null, total: 6 };
  const ranked = filterAndRankAccommodations(LE_1837_CANDIDATES, party);

  it("excludes every category whose real maxGuests is below 6, without touching any capacity value", () => {
    expect(ranked.map((c) => c.name).sort()).toEqual(["Junior PMR", "Junior Suite"].sort());
  });

  it("never invents/widens a capacity to fit — Mini-suite/Standard (2), Superior/Deluxe/Deluxe PMR (4) all correctly excluded", () => {
    const names = ranked.map((c) => c.name);
    for (const excluded of ["Mini-suite", "Standard", "Superior", "Deluxe", "Deluxe PMR"]) {
      expect(names).not.toContain(excluded);
    }
  });
});

/**
 * Source-level wiring — answerQuestion/answerGrounded/answerNoContext can't
 * be unit-tested directly here (Supabase + OpenAI), same constraint as
 * every other answer.ts test file in this repo.
 */
describe("answer.ts wiring — roomCatalogue", () => {
  it("[deterministic, independent of groundingMode] computed once from rankedCandidates via shouldAskPartySizeOnly, right after the capacity+availability filters — never gated on groundingMode/retrieval", () => {
    const computeStart = source.indexOf("const askPartySizeOnly = shouldAskPartySizeOnly(roomDiscoveryIntentDetected, mentionsPreciseAccommodation, party);");
    expect(computeStart).toBeGreaterThan(-1);
    const catalogueBlock = source.slice(computeStart, source.indexOf(": [];", computeStart) + ": [];".length);
    expect(catalogueBlock).toMatch(/roomDiscoveryIntentDetected && !askPartySizeOnly\s*\n\s*\? rankedCandidates\.map/);
    expect(catalogueBlock).not.toMatch(/groundingMode/);

    // Computed BEFORE the grounded/no_context branch decision (applies to both).
    const branchIndex = source.indexOf('if (groundingMode === "grounded")');
    expect(computeStart).toBeLessThan(branchIndex);
  });

  it("[only 4 fields, never a price] the mapped entry shape is exactly accommodationTypeId/name/pageUrl/maxGuests — structurally incapable of leaking a tariff regardless of allow_price_communication", () => {
    const mapStart = source.indexOf("rankedCandidates.map((c) => ({");
    const mapEnd = source.indexOf("}))", mapStart);
    const mapBlock = source.slice(mapStart, mapEnd);
    expect(mapBlock).toMatch(/accommodationTypeId: c\.id,/);
    expect(mapBlock).toMatch(/name: c\.name,/);
    expect(mapBlock).toMatch(/pageUrl: accommodationTypesById\.get\(c\.id\)\?\.source_url \?\? null,/);
    expect(mapBlock).toMatch(/maxGuests: c\.maxGuests,/);
    expect(mapBlock).not.toMatch(/price/i);
    expect(mapBlock).not.toMatch(/€|EUR/);
  });

  it("[threaded into both branches] answerGrounded and answerNoContext both receive roomCatalogue, and both return it", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/roomCatalogue,/);

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/roomCatalogue,/);

    expect(source).toMatch(/return \{ reply, sources: relevantChunks, answerStatus: "answered", roomRecommendation, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt, roomCatalogue \};/);
    expect(source).toMatch(/return \{ reply, sources: \[\], answerStatus, roomRecommendation: null, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt, roomCatalogue \};/);
  });

  it("[error path] the generic error fallback always returns an empty roomCatalogue, never omitted/undefined", () => {
    expect(source).toMatch(/roomCatalogue: \[\] \};/);
  });

  it("[never rewrites ROOM_DISCOVERY's own detection/continuation] isRoomDiscoveryIntent, lastAssistantMessageIndicatesRoomDiscoveryContinuation, and withRoomDiscoveryMarker are all untouched call sites — this chantier only adds a new deterministic field alongside them", () => {
    expect(source).toMatch(/const roomDiscoveryContinuationSignal = lastAssistantMessageIndicatesRoomDiscoveryContinuation\(historyInput\);/);
    expect(source).toMatch(/isRoomDiscoveryIntent\(message\)/);
    expect(source).toMatch(/withRoomDiscoveryMarker\(reply\)/);
  });
});

/**
 * API surface — both callers of answerQuestion's result must serialize the
 * new field, or the widget/admin-test UI would never receive it despite the
 * server computing it correctly.
 */
describe("API wiring — roomCatalogue reaches every chat response", () => {
  it("[public widget route] serializes result.roomCatalogue", () => {
    const routeSource = readFileSync(join(here, "..", "..", "app", "api", "widget", "[widgetKey]", "chat", "route.ts"), "utf8");
    expect(routeSource).toMatch(/roomCatalogue: result\.roomCatalogue,/);
  });

  it("[shared superadmin/client test handler] serializes result.roomCatalogue", () => {
    const chatEndpointSource = readFileSync(join(here, "chatEndpoint.ts"), "utf8");
    expect(chatEndpointSource).toMatch(/roomCatalogue: result\.roomCatalogue,/);
  });
});
