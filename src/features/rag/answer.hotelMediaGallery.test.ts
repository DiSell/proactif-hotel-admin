import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { detectHotelMediaCategory, isHotelMediaPhotoRequest } from "./hotelMediaGallery";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * HOTEL_MEDIA CHATBOT chantier — source-level wiring, same constraint as
 * every other answer.ts test file in this repo (see
 * answer.accommodationSummary.test.ts's own doc comment: Supabase + OpenAI,
 * no mocking infra for answerQuestion itself). Real invocation is used for
 * the two pure detectors (hotelMediaGallery.test.ts covers those
 * exhaustively); this file only pins the ORCHESTRATION around them.
 */
describe("answer.ts wiring — hotelMediaGallery", () => {
  it("[gated by BOTH isHotelMediaPhotoRequest AND detectHotelMediaCategory] a bare factual question never populates this field, even if a category keyword is present", () => {
    const computeStart = source.indexOf("const requestedHotelMediaCategory =");
    expect(computeStart).toBeGreaterThan(-1);
    const line = source.slice(computeStart, source.indexOf(";", computeStart));
    expect(line).toMatch(/isHotelMediaPhotoRequest\(message\) \? detectHotelMediaCategory\(message\) : null/);
  });

  it("[category is never chosen by the model] detectHotelMediaCategory only ever receives the raw visitor message, never a model output field", () => {
    const computeStart = source.indexOf("const requestedHotelMediaCategory =");
    const block = source.slice(computeStart, computeStart + 200);
    expect(block).not.toMatch(/output_parsed/);
  });

  it("[loader called with supabase/hotelId/the detected category]", () => {
    expect(source).toMatch(/loadSelectedHotelMediaPhotos\(supabase, hotelId, requestedHotelMediaCategory\)/);
  });

  it("[zero photos -> null, never an object with an empty photos array] the ternary's only truthy branch requires hotelMediaPhotos.length > 0", () => {
    const computeStart = source.indexOf("const hotelMediaGallery: HotelMediaGallery | null =");
    const block = source.slice(computeStart, computeStart + 700);
    expect(block).toMatch(/requestedHotelMediaCategory && hotelMediaPhotos\.length > 0/);
    expect(block).toMatch(
      /\? \{ category: requestedHotelMediaCategory, label: HOTEL_MEDIA_CATEGORY_LABEL\[requestedHotelMediaCategory\], photos: hotelMediaPhotos \}\s*\n\s*: null;/
    );
  });

  it("[label reused from HOTEL_MEDIA_CATEGORY_LABEL, never a second, parallel label map]", () => {
    expect(source).toMatch(/import \{ HOTEL_MEDIA_CATEGORY_LABEL \} from "@\/features\/hotelMedia\/schema";/);
    expect(source).not.toMatch(/const\s+HOTEL_MEDIA_CATEGORY_LABEL\s*=/);
  });

  it("[never gated on groundingMode] computed once in answerQuestion, before the grounded/no_context branch decision — independent of retrieval, exactly like roomCatalogue/accommodationSummary", () => {
    const computeStart = source.indexOf("const requestedHotelMediaCategory =");
    const branchIndex = source.indexOf('if (groundingMode === "grounded")');
    expect(computeStart).toBeGreaterThan(-1);
    expect(computeStart).toBeLessThan(branchIndex);
  });

  it("[threaded into both branches] answerGrounded and answerNoContext both receive hotelMediaGallery as a param, both destructure it, and both return it", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/hotelMediaGallery,/);

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/hotelMediaGallery,/);

    // Both param type blocks declare it.
    const paramTypeOccurrences = source.match(/hotelMediaGallery: HotelMediaGallery \| null;/g) ?? [];
    expect(paramTypeOccurrences.length).toBe(2);

    // Both final returns include it.
    expect(source).toMatch(/roomCatalogue, accommodationSummary, hotelMediaGallery \};/);
  });

  it("[error path] the generic error fallback always returns hotelMediaGallery: null, never omitted/undefined", () => {
    expect(source).toMatch(/roomCatalogue: \[\], accommodationSummary: \[\], hotelMediaGallery: null \};/);
  });

  it("[Cas E — room-specific requests never populate hotelMediaGallery] buildRoomRecommendation itself never references hotelMediaGallery — the two are computed independently, with no cross-exclusion logic needed because accommodation names never match a hotel_media category keyword", () => {
    const fnStart = source.indexOf("async function buildRoomRecommendation(");
    const fnEnd = source.indexOf("\n}", fnStart);
    const block = source.slice(fnStart, fnEnd);
    expect(block).not.toMatch(/hotelMediaGallery/);
  });
});

/**
 * CORRECTION CIBLÉE chantier — the model must be told the deterministic
 * truth BEFORE it writes its reply, not just handed the final gallery
 * object for the client payload after the fact. requestedHotelMediaCategory
 * (raw, non-null even at 0 photos) is threaded alongside hotelMediaGallery
 * specifically so buildHotelInstructions' hotelMediaGalleryRequest can be
 * computed for BOTH the >0 and ===0 cases — see prompt.hotelMediaGallery.test.ts
 * for what the model actually reads.
 */
describe("answer.ts wiring — hotelMediaGalleryRequest fed to buildHotelInstructions BEFORE the model call", () => {
  it("[requestedHotelMediaCategory threaded alongside hotelMediaGallery into both branches]", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/requestedHotelMediaCategory,/);

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/requestedHotelMediaCategory,/);

    const paramTypeOccurrences = source.match(/requestedHotelMediaCategory: HotelMediaCategory \| null;/g) ?? [];
    expect(paramTypeOccurrences.length).toBe(2);
  });

  it("[both buildHotelInstructions call sites pass hotelMediaGalleryRequest, derived from requestedHotelMediaCategory + hotelMediaGallery?.photos.length]", () => {
    const occurrences = source.match(
      /hotelMediaGalleryRequest: requestedHotelMediaCategory\s*\n\s*\? \{ label: HOTEL_MEDIA_CATEGORY_LABEL\[requestedHotelMediaCategory\], photoCount: hotelMediaGallery\?\.photos\.length \?\? 0 \}\s*\n\s*: null,/g
    ) ?? [];
    expect(occurrences.length).toBe(2);
  });

  it("[computed before the model call in both branches] hotelMediaGalleryRequest is built as part of the same buildHotelInstructions({...}) call whose result (instructions) is passed to the model — never assembled after the response", () => {
    const groundedFnStart = source.indexOf("async function answerGrounded(");
    const groundedFn = source.slice(groundedFnStart, source.indexOf("async function answerNoContext("));
    const instructionsCallStart = groundedFn.indexOf("const instructions = buildHotelInstructions({");
    const requestIndex = groundedFn.indexOf("hotelMediaGalleryRequest:", instructionsCallStart);
    const responseCallIndex = groundedFn.indexOf("client.responses.parse(");
    expect(instructionsCallStart).toBeGreaterThan(-1);
    expect(requestIndex).toBeGreaterThan(instructionsCallStart);
    expect(responseCallIndex).toBeGreaterThan(requestIndex);
  });

  it("[0 photos still feeds hotelMediaGalleryRequest with photoCount: 0, via the ?? 0 fallback — never left undefined for the model]", () => {
    expect(source).toMatch(/photoCount: hotelMediaGallery\?\.photos\.length \?\? 0/);
  });
});

/**
 * TEST A/B/E/F (mission item 8) — real invocation of the two pure
 * detectors proving the exact scenarios the mission asked for. Case C
 * (is_selected=false never returned) and case D (position ASC order
 * preserved) are both covered by hotelMediaGallery.test.ts's own
 * real-invocation tests of the loader itself — the query-level filter and
 * ordering are the actual guarantees, pinned there, not re-derived here.
 */
describe("TEST A/B/E/F — hotelMediaGallery end-to-end scenarios (detector level)", () => {
  it("[A] 'Montrez-moi la piscine' -> visual intent + category 'pool'", () => {
    const message = "Montrez-moi la piscine";
    expect(isHotelMediaPhotoRequest(message)).toBe(true);
    expect(detectHotelMediaCategory(message)).toBe("pool");
  });

  it("[B] 'Montrez-moi le sauna' -> visual intent + category 'sauna' detected (the loader then returns 0 photos today, which answer.ts's own gate turns into null — see the wiring test above for the null-on-zero-photos guarantee)", () => {
    const message = "Montrez-moi le sauna";
    expect(isHotelMediaPhotoRequest(message)).toBe(true);
    expect(detectHotelMediaCategory(message)).toBe("sauna");
  });

  it("[E] 'Montrez-moi la Deluxe' -> visual intent detected, but NO hotel_media category matches an accommodation name", () => {
    const message = "Montrez-moi la Deluxe";
    expect(isHotelMediaPhotoRequest(message)).toBe(true);
    expect(detectHotelMediaCategory(message)).toBeNull();
  });

  it("[F] 'Avez-vous une piscine ?' -> no visual intent, even though the category keyword is present", () => {
    const message = "Avez-vous une piscine ?";
    expect(isHotelMediaPhotoRequest(message)).toBe(false);
    expect(detectHotelMediaCategory(message)).toBe("pool");
  });
});
