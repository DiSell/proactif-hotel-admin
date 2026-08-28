import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "answer.ts"), "utf8");

/**
 * Regression guards for the grounded / no_context split. answerQuestion()
 * can't be unit-tested directly here (it needs Supabase + OpenAI, and this
 * codebase has no mocking infrastructure for either — see
 * similarityThreshold.test.ts for the same constraint), so these check the
 * source-level shape that the fix requires instead.
 */
describe("answerQuestion — grounded / no_context split", () => {
  it("[A] no longer short-circuits to a static fallback before calling the model when no chunks are found", () => {
    // The old anti-pattern: an early return of a canned reply, gated only
    // on relevantChunks.length === 0, with no OpenAI call anywhere near it.
    expect(source).not.toMatch(/relevantChunks\.length === 0\)\s*\{\s*\n\s*const reply = settings/);

    // The new shape: both branches are real, separate functions that each
    // call the OpenAI client — "no chunks" no longer means "no model call".
    const groundedFn = source.slice(source.indexOf("async function answerGrounded"), source.indexOf("async function answerNoContext"));
    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(groundedFn).toMatch(/getOpenAIClient\(/);
    expect(noContextFn).toMatch(/getOpenAIClient\(/);
  });

  it("[C] only the grounded branch ever builds a knowledge reference block — no_context never gets one", () => {
    const callSites = source.match(/buildKnowledgeReferenceBlock\(/g) || [];
    expect(callSites.length).toBe(1);

    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(noContextFn).not.toMatch(/buildKnowledgeReferenceBlock/);
  });

  it("[F] no_context self-classifies answerStatus via structured output instead of a hardcoded status", () => {
    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(noContextFn).toMatch(/zodTextFormat\(noContextReplySchema/);
    expect(noContextFn).toMatch(/answerStatus = response\.output_parsed\.answerStatus/);
    // Unlike the grounded branch, which can hardcode "answered" because
    // finding relevant chunks is itself the signal.
    const groundedFn = source.slice(source.indexOf("async function answerGrounded"), source.indexOf("async function answerNoContext"));
    expect(groundedFn).toMatch(/answerStatus:\s*"answered"/);
  });

  it("groundingMode is computed from relevantChunks.length, not hardcoded, and drives which branch runs", () => {
    expect(source).toMatch(/groundingMode:\s*GroundingMode\s*=\s*relevantChunks\.length > 0 \? "grounded" : "no_context"/);
  });
});

/**
 * Regression guards for the accommodation-recommendation structured output —
 * same testing constraint as above (no Supabase/OpenAI mocking here).
 */
describe("answerGrounded — accommodation recommendation", () => {
  it("uses structured output (responses.parse + groundedReplySchema), not the old plain responses.create/output_text", () => {
    const groundedFn = source.slice(source.indexOf("async function answerGrounded"), source.indexOf("async function answerNoContext"));
    expect(groundedFn).toMatch(/zodTextFormat\(groundedReplySchema/);
    expect(groundedFn).toMatch(/recommendedAccommodationTypeId = response\.output_parsed\.recommendedAccommodationTypeId/);
    expect(groundedFn).not.toMatch(/responses\.create\(/);
    expect(groundedFn).not.toMatch(/response\.output_text/);
  });

  it("recommendedAccommodationTypeId is validated against rankedCandidates (the exact offered list), not just looked up by hotel_id", () => {
    const fn = source.slice(source.indexOf("async function buildRoomRecommendation"), source.indexOf("async function answerGrounded"));
    // Matched against the already-filtered candidate list first...
    expect(fn).toMatch(/rankedCandidates\.find\(\(c\) => c\.id === recommendedAccommodationTypeId\)/);
    // ...and hotel_id is still cross-checked as a second, independent guard.
    expect(fn).toMatch(/accommodationType\.hotel_id !== hotelId/);
  });

  it("groundedReplySchema's recommendedAccommodationTypeId is documented as untrusted raw model output, never coerced directly into a recommendation", () => {
    // The doc comment sits directly above the schema declaration.
    const schemaIndex = source.indexOf("const groundedReplySchema");
    const docCommentStart = source.lastIndexOf("/**", schemaIndex);
    const doc = source.slice(docCommentStart, schemaIndex);
    expect(doc).toMatch(/UNVERIFIED/);
  });

  it("buildAccommodationGuidance / rankedCandidates are only ever computed inside the grounded branch of answerQuestion, never the no_context branch", () => {
    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(noContextFn).not.toMatch(/rankedCandidates/);
    expect(noContextFn).not.toMatch(/accommodation_types/);
  });
});

/**
 * Regression guards for RoomRecommendation.bookingUrl being native to
 * answerQuestion()'s own output (P0-3) — no route is allowed to bolt it on
 * anymore, and it must be structurally impossible for the model to supply
 * one instead of the hotel's actual configured URL.
 */
describe("buildRoomRecommendation — bookingUrl", () => {
  function sliceFn(name: string, nextName: string): string {
    const start = source.indexOf(`async function ${name}`);
    const end = source.indexOf(`async function ${nextName}`);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("[native field] the returned object includes bookingUrl, sourced from the function's own bookingUrl parameter — not derived, not defaulted", () => {
    const fn = sliceFn("buildRoomRecommendation", "answerGrounded");
    // Anchored right after pageUrl (the return object's second-to-last
    // field) rather than matching the whole `return { ... }` block, since
    // the photos line contains its own nested { url, alt } object literal
    // that would otherwise break a naive brace-balanced match.
    expect(fn).toMatch(/pageUrl: accommodationType\.source_url,\s*\n\s*bookingUrl,\s*\n\s*\};/);
  });

  it("[server-sourced only] bookingUrl is passed into buildRoomRecommendation from hotel.booking_url at the call site — the already-loaded hotel row, not the model's output", () => {
    const groundedFn = sliceFn("answerGrounded", "answerNoContext");
    expect(groundedFn).toMatch(/buildRoomRecommendation\(supabase,\s*\{[^}]*bookingUrl:\s*hotel\.booking_url,?[^}]*\}\)/);
  });

  it("[no model URL field] neither structured-output schema exposes anything a model could use to supply its own booking URL", () => {
    const groundedSchemaStart = source.indexOf("const groundedReplySchema");
    const noContextSchemaStart = source.indexOf("const noContextReplySchema");
    const groundedSchema = source.slice(groundedSchemaStart, source.indexOf("});", groundedSchemaStart));
    const noContextSchema = source.slice(noContextSchemaStart, source.indexOf("});", noContextSchemaStart));
    expect(groundedSchema).not.toMatch(/url/i);
    expect(noContextSchema).not.toMatch(/url/i);
  });
});

/**
 * Regression guards for the generic booking CTA (P0-1) — independent of
 * RoomRecommendation, must reach the visitor even when no specific room was
 * recommended (grounded with no match, or no_context entirely). Runtime
 * behavior of isBookingIntent/buildBookingAction themselves is covered by
 * real unit tests in bookingAction.test.ts; this file only guards how the
 * two branches WIRE those pure functions in, since answerGrounded/
 * answerNoContext can't be unit-tested directly here (Supabase + OpenAI).
 */
describe("answer.ts — generic booking CTA (action)", () => {
  function sliceFn(name: string, nextName: string): string {
    const start = source.indexOf(`async function ${name}`);
    const end = source.indexOf(`async function ${nextName}`);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("[computed once] bookingIntentDetected is computed in answerQuestion itself, before branching — not re-derived separately in each branch", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    expect(answerQuestionFn).toMatch(/const bookingIntentDetected = isBookingIntent\(message\);/);

    // Scoped precisely to each call's own argument object (not a greedy
    // match that could straddle both calls and pass even if
    // bookingIntentDetected were missing from one of them specifically).
    const groundedCallStart = answerQuestionFn.indexOf("return answerGrounded(supabase, {");
    const groundedCallEnd = answerQuestionFn.indexOf("});", groundedCallStart);
    expect(answerQuestionFn.slice(groundedCallStart, groundedCallEnd)).toMatch(/bookingIntentDetected,/);

    const noContextCallStart = answerQuestionFn.indexOf("return answerNoContext(supabase, {");
    const noContextCallEnd = answerQuestionFn.indexOf("});", noContextCallStart);
    expect(answerQuestionFn.slice(noContextCallStart, noContextCallEnd)).toMatch(/bookingIntentDetected,/);
  });

  it("[no_context — works with no RoomRecommendation at all] answerNoContext attaches action from bookingIntentDetected + the hotel's own booking config directly, and returns it", () => {
    const fn = sliceFn("answerNoContext", "loadHistory");
    expect(fn).toMatch(/const action = buildBookingAction\(bookingIntentDetected, hotel\);/);
    expect(fn).toMatch(/return \{ reply, sources: \[\], answerStatus, roomRecommendation: null, action, partnerRecommendations, partnerRequestPhonePrompt \};/);
  });

  it("[grounded — dedup with RoomRecommendation] answerGrounded suppresses the generic action ONLY when a RoomRecommendation already renders its own working booking link (booking_action_mode === \"url\") — never when the hotel is in host_widget mode, where RoomPhotoModal has no button of its own", () => {
    const fn = sliceFn("answerGrounded", "answerNoContext");
    expect(fn).toMatch(/const hasDuplicateBookingLink = Boolean\(roomRecommendation\) && bookingCtaKind\(hotel\) === "url";/);
    expect(fn).toMatch(/const action = hasDuplicateBookingLink \? null : buildBookingAction\(bookingIntentDetected, hotel\);/);
    expect(fn).toMatch(/return \{ reply, sources: relevantChunks, answerStatus: "answered", roomRecommendation, action, partnerRecommendations, partnerRequestPhonePrompt \};/);
  });

  it("[single source of truth] buildBookingAction is the ONLY place an action object literal ({ type: \"booking\", ... }) is constructed — never inlined again at either call site", () => {
    const actionLiteralCount = (source.match(/\{\s*type:\s*"booking"/g) ?? []).length;
    expect(actionLiteralCount).toBe(1);
  });
});

/**
 * Regression guards for making the availability pipeline orthogonal to
 * groundingMode — same testing constraint as above.
 */
describe("answerQuestion — availability is orthogonal to groundingMode", () => {
  it("the stay-request/availability pipeline runs BEFORE the grounded/no_context branch decision, not nested inside it", () => {
    const gateIndex = source.indexOf("shouldResolveStayContext(message)");
    const branchIndex = source.indexOf('if (groundingMode === "grounded")');
    expect(gateIndex).toBeGreaterThan(-1);
    expect(branchIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(branchIndex);
  });

  it("answerNoContext also receives and forwards availabilityCheckState to buildHotelInstructions — never conditioned on grounded", () => {
    const noContextFn = source.slice(source.indexOf("async function answerNoContext"), source.indexOf("async function loadHistory"));
    expect(noContextFn).toMatch(/availabilityCheckState/);
    expect(noContextFn).toMatch(/buildHotelInstructions\(\{[^}]*availabilityCheckState/);
  });

  it("answerGrounded also forwards availabilityCheckState to buildHotelInstructions", () => {
    const groundedFn = source.slice(source.indexOf("async function answerGrounded"), source.indexOf("async function answerNoContext"));
    expect(groundedFn).toMatch(/buildHotelInstructions\(\{[^}]*availabilityCheckState/);
  });

  it("[no field pre-filtering] answerQuestion never tests checkIn/checkOut/adults before calling checkAvailability — only isAvailabilityRequest gates the call", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    expect(answerQuestionFn).not.toMatch(/if\s*\(\s*(validatedState\.)?checkIn\b/);
    expect(answerQuestionFn).not.toMatch(/if\s*\(\s*(validatedState\.)?checkOut\b/);
    const checkAvailabilityCallIndex = answerQuestionFn.indexOf("checkAvailability({");
    const gateCallIndex = answerQuestionFn.indexOf("isAvailabilityRequest(message)");
    expect(checkAvailabilityCallIndex).toBeGreaterThan(-1);
    expect(gateCallIndex).toBeGreaterThan(-1);
    expect(gateCallIndex).toBeLessThan(checkAvailabilityCallIndex);
  });

  it("applyAvailabilityToCandidates runs on every turn's rankedCandidates, not only inside the grounded branch", () => {
    const answerQuestionFn = source.slice(source.indexOf("export async function answerQuestion"), source.indexOf("type HistoryInputItem"));
    const branchIndex = answerQuestionFn.indexOf('if (groundingMode === "grounded")');
    const applyIndex = answerQuestionFn.indexOf("applyAvailabilityToCandidates(");
    expect(applyIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeLessThan(branchIndex);
  });
});
