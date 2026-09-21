import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterAndRankAccommodations, isRoomDiscoveryIntent, shouldAskPartySizeOnly, type AccommodationCandidate } from "./accommodationRanking";
import { extractPartySize, isPartyKnown, type PartySize } from "./partySize";
import { isBookingIntent, isReservationIntent } from "./answer";
import { lastAssistantMessageIndicatesBookingIntent, withBookingIntentMarker } from "./bookingIntentContinuation";
import { lastAssistantMessageIndicatesRoomDiscoveryContinuation } from "./roomDiscoveryContinuation";

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
  it("[deterministic, independent of groundingMode] computed once from rankedCandidates via catalogueRankedCandidates, right after the capacity+availability filters — never gated on groundingMode/retrieval", () => {
    const computeStart = source.indexOf(
      "const catalogueRankedCandidates = applyAvailabilityToCandidates(filterAndRankAccommodations(candidates, deterministicParty), availabilityCheckState);"
    );
    expect(computeStart).toBeGreaterThan(-1);
    const catalogueBlock = source.slice(computeStart, source.indexOf(": [];", computeStart) + ": [];".length);
    expect(catalogueBlock).not.toMatch(/groundingMode/);

    // Computed BEFORE the grounded/no_context branch decision (applies to both).
    const branchIndex = source.indexOf('if (groundingMode === "grounded")');
    expect(computeStart).toBeLessThan(branchIndex);
  });

  /**
   * PRODUCTION BUG, reproduced and fixed: "Je veux voir la Deluxe" right
   * after a catalogue turn ("montre-moi les chambres" -> "2 personnes")
   * returned BOTH roomRecommendation=Deluxe AND a 7-entry roomCatalogue in
   * the SAME API response — confirmed by direct reproduction against the
   * real dev server, NOT a frontend history-rendering artifact as first
   * hypothesized. Cause: roomDiscoveryIntentDetected stays true via the
   * stale continuation marker (roomDiscoveryContinuation.ts) even once a
   * precise category is named, and shouldAskPartySizeOnly's own false
   * already covers BOTH "party known, generic turn" AND "precise category
   * named this turn" — gating the catalogue on !askPartySizeOnly alone
   * couldn't tell those apart. Fix: the catalogue's own gate explicitly
   * checks !mentionsPreciseAccommodation too, never inferred from
   * askPartySizeOnly alone.
   */
  it("[the exact production bug, fixed] the catalogue gate explicitly excludes mentionsPreciseAccommodation, never relying on isGenuineCatalogueTurn alone to imply it", () => {
    const computeStart = source.indexOf(
      "const catalogueRankedCandidates = applyAvailabilityToCandidates(filterAndRankAccommodations(candidates, deterministicParty), availabilityCheckState);"
    );
    const catalogueBlock = source.slice(computeStart, source.indexOf(": [];", computeStart) + ": [];".length);
    expect(catalogueBlock).toMatch(
      /isCatalogueEligibleTurn &&\s*\n\s*!mentionsPreciseAccommodation &&\s*\n\s*isGenuineCatalogueTurn &&\s*\n\s*\(requestedRoomsCount === null \|\| requestedRoomsCount <= 1\)\s*\n\s*\? catalogueRankedCandidates\.map/
    );
  });

  /**
   * 3-INTENTIONS chantier (audit "AUDIT INTENTIONS HÉBERGEMENTS", mission
   * item 4): a genuine CATALOGUE/browsing turn ("Montrez-moi vos
   * logements.") must show every category immediately, capacity known or
   * not — isPartyKnown(deterministicParty) is deliberately no longer part
   * of this gate. catalogueRankedCandidates (filterAndRankAccommodations)
   * already returns every candidate as "unknown fit" when the party is
   * unknown, and the real capacity-filtered subset once it IS known — the
   * gate only ever decided WHETHER to show the list, never HOW to filter
   * it. bookingReady (the BOOKING side of isCatalogueEligibleTurn) still
   * requires isPartyKnown on its own formula, untouched.
   */
  it("[3-INTENTIONS] the catalogue gate no longer requires isPartyKnown — a browsing turn shows the full list even with capacity unknown", () => {
    const computeStart = source.indexOf(
      "const catalogueRankedCandidates = applyAvailabilityToCandidates(filterAndRankAccommodations(candidates, deterministicParty), availabilityCheckState);"
    );
    const catalogueBlock = source.slice(computeStart, source.indexOf(": [];", computeStart) + ": [];".length);
    expect(catalogueBlock).not.toMatch(/isPartyKnown\(deterministicParty\) &&\s*\n\s*isGenuineCatalogueTurn/);
  });

  it("[FIFTH/SIXTH extension, BOOKING-eligible catalogue] isCatalogueEligibleTurn accepts either roomDiscoveryIntentDetected or (bookingIntentDetected && bookingReady) — a booking conversation is no longer silently excluded from the catalogue, but (BOOKING TUNNEL chantier) must also have dates known, unlike ROOM_DISCOVERY which never requires dates", () => {
    const computeStart = source.indexOf("const isCatalogueEligibleTurn = roomDiscoveryIntentDetected || (bookingIntentDetected && bookingReady);");
    expect(computeStart).toBeGreaterThan(-1);
    const catalogueBlock = source.slice(computeStart, source.indexOf(": [];", computeStart) + ": [];".length);
    expect(catalogueBlock).toMatch(/isCatalogueEligibleTurn &&/);

    // bookingIntentDetected itself is untouched — same formula/semantics as ever, only its
    // declaration moved earlier (right after roomDiscoveryIntentDetected) so this gate can read it.
    const bookingIntentStart = source.indexOf("const bookingIntentDetected =");
    expect(bookingIntentStart).toBeGreaterThan(-1);
    expect(bookingIntentStart).toBeLessThan(computeStart);
    const roomDiscoveryIntentStart = source.indexOf("const roomDiscoveryIntentDetected =");
    expect(roomDiscoveryIntentStart).toBeGreaterThan(-1);
    expect(roomDiscoveryIntentStart).toBeLessThan(bookingIntentStart);
    expect(source.slice(bookingIntentStart, bookingIntentStart + 200)).toMatch(
      /const bookingIntentDetected =\s*\n\s*!roomDiscoveryIntentDetected && \(isBookingIntent\(message\) \|\| lastAssistantMessageIndicatesBookingIntent\(historyInput\)\);/
    );
  });

  /**
   * SECOND PRODUCTION BUG, reproduced and fixed: a genuinely fresh "bonjour"
   * (brand-new conversation, no history) correctly returns roomCatalogue=[]
   * — confirmed by direct reproduction. But "bonjour" (or "merci", "avez-vous
   * un parking ?", any wholly unrelated message) sent AFTER an established
   * room-discovery flow ("montre-moi les chambres" -> "2 personnes") incorrectly
   * returned the full 7-entry catalogue — because
   * lastAssistantMessageIndicatesRoomDiscoveryContinuation
   * (roomDiscoveryContinuation.ts) deliberately keeps roomDiscoveryIntentDetected
   * true for the REST of the conversation once the marker is set (correct
   * for its own original purpose), and once party became known once,
   * "roomDiscoveryIntentDetected && !mentionsPreciseAccommodation &&
   * !askPartySizeOnly" alone stayed true for every later message
   * regardless of what it actually said. Fix: isGenuineCatalogueTurn —
   * true only when THIS message either freshly matches isRoomDiscoveryIntent
   * or itself states a group size (messageAloneStatesPartySize, captured
   * from extractPartySize(message) BEFORE any history-based enrichment) —
   * never inferred from the stale continuation flag alone.
   */
  it("[the second production bug, fixed] isGenuineCatalogueTurn requires either a fresh discovery phrasing or the message itself supplying the party size — never the stale continuation flag alone", () => {
    const computeStart = source.indexOf("const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || messageAloneStatesPartySize;");
    expect(computeStart).toBeGreaterThan(-1);

    // messageAloneStatesPartySize captured from the single-message extraction, BEFORE the history-based merge overwrites `party`.
    const captureStart = source.indexOf("const messageAloneStatesPartySize = isPartyKnown(party);");
    expect(captureStart).toBeGreaterThan(-1);
    const historyMergeIndex = source.indexOf("party = extractPartySizeFromHistory(historyInput) ?? party;");
    expect(captureStart).toBeLessThan(historyMergeIndex);
  });

  it("[pure logic, real functions] reproduces the exact bug scenario: a room-discovery flow already live (party known) does NOT show the catalogue for an unrelated message, but still shows it for a genuine party-size reply or a fresh discovery phrasing", () => {
    function wouldShowCatalogue(message: string, roomDiscoveryIntentDetected: boolean, mentionsPreciseAccommodation: boolean, party: PartySize): boolean {
      const askPartySizeOnly = shouldAskPartySizeOnly(roomDiscoveryIntentDetected, mentionsPreciseAccommodation, party);
      const messageAloneStatesPartySize = isPartyKnown(extractPartySize(message));
      const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || messageAloneStatesPartySize;
      return roomDiscoveryIntentDetected && !mentionsPreciseAccommodation && !askPartySizeOnly && isGenuineCatalogueTurn;
    }

    const knownParty: PartySize = { adults: null, children: null, total: 2 };

    // THE BUG: continuation still live, party already known, but "bonjour" itself is unrelated.
    expect(wouldShowCatalogue("bonjour", true, false, knownParty)).toBe(false);
    expect(wouldShowCatalogue("merci", true, false, knownParty)).toBe(false);
    expect(wouldShowCatalogue("avez-vous un parking ?", true, false, knownParty)).toBe(false);
    expect(wouldShowCatalogue("à quelle heure est le petit déjeuner ?", true, false, knownParty)).toBe(false);

    // Must still work: the direct "2 personnes" reply answering "combien de personnes ?".
    expect(wouldShowCatalogue("2 personnes", true, false, knownParty)).toBe(true);

    // Must still work: a fresh, explicit discovery phrasing, party already known.
    expect(wouldShowCatalogue("montre-moi les chambres", true, false, knownParty)).toBe(true);
  });

  it("[pure logic, real inputs] a precise category named while roomDiscoveryIntentDetected is only true via a stale continuation signal never produces a non-empty catalogue", () => {
    // Mirrors the exact three-part gate now in answer.ts, using the real shouldAskPartySizeOnly.
    function wouldShowCatalogue(roomDiscoveryIntentDetected: boolean, mentionsPreciseAccommodation: boolean, party: PartySize): boolean {
      const askPartySizeOnly = shouldAskPartySizeOnly(roomDiscoveryIntentDetected, mentionsPreciseAccommodation, party);
      return roomDiscoveryIntentDetected && !mentionsPreciseAccommodation && !askPartySizeOnly;
    }

    // "Je veux voir la Deluxe": continuation marker still live (roomDiscoveryIntentDetected=true), party already known from the previous turn, but THIS message names a precise category.
    expect(wouldShowCatalogue(true, true, { adults: null, children: null, total: 2 })).toBe(false);

    // The genuine generic case ("2 personnes" answering "combien de personnes ?") must still show it.
    expect(wouldShowCatalogue(true, false, { adults: null, children: null, total: 2 })).toBe(true);
  });

  it("[only 4 fields, never a price] the mapped entry shape is exactly accommodationTypeId/name/pageUrl/maxGuests — structurally incapable of leaking a tariff regardless of allow_price_communication", () => {
    const mapStart = source.indexOf("catalogueRankedCandidates.map((c) => ({");
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

    expect(source).toMatch(/return \{ reply, sources: relevantChunks, answerStatus: "answered", roomRecommendation, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt, roomCatalogue, accommodationSummary \};/);
    expect(source).toMatch(/return \{ reply, sources: \[\], answerStatus, roomRecommendation: null, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt, roomCatalogue, accommodationSummary \};/);
  });

  /**
   * THIRD PRODUCTION BUG (theoretical hardening — the exact literal
   * "je charche une chambre" alone was NOT reproducible against a genuinely
   * fresh conversation on this HEAD; this closes a real, confirmed
   * code-level gap regardless): mergeValidatedStayRequestIntoParty
   * (partySize.ts) folds resolveStayRequestFromHistory's OWN output — an
   * LLM call — into `party`. That call is explicitly instructed
   * ("Ne devine jamais une valeur non exprimée...") never to guess an
   * unstated adults/children count, but this field's entire reason to
   * exist (see RoomCatalogueEntry's own doc comment) is to never depend on
   * the model's good behavior for something this visible. Fix:
   * deterministicParty — captured from extractPartySize/
   * extractPartySizeFromHistory ONLY, before mergeValidatedStayRequestIntoParty
   * can touch it — is used for the catalogue's own gate AND its own
   * candidate list (catalogueRankedCandidates), never `party`/`rankedCandidates`
   * (which keep the LLM-resolved value for everything else: prompt
   * guidance, the model's own offered candidates, booking).
   */
  it("[hardened against LLM-derived party] the gate and the candidate list both use deterministicParty, never the LLM-mergeable `party`", () => {
    const computeStart = source.indexOf("const catalogueRankedCandidates = applyAvailabilityToCandidates(filterAndRankAccommodations(candidates, deterministicParty), availabilityCheckState);");
    expect(computeStart).toBeGreaterThan(-1);
    // Must be computed AFTER mergeValidatedStayRequestIntoParty could have run, so it can never accidentally read party's PRE-merge value under a different name.
    const mergeIndex = source.indexOf("party = mergeValidatedStayRequestIntoParty(party, validatedState);");
    expect(mergeIndex).toBeGreaterThan(-1);
    expect(computeStart).toBeGreaterThan(mergeIndex);

    // deterministicParty itself must be snapshotted BEFORE that merge call exists at all.
    const snapshotIndex = source.indexOf("const deterministicParty: PartySize = party;");
    expect(snapshotIndex).toBeGreaterThan(-1);
    expect(snapshotIndex).toBeLessThan(mergeIndex);
  });

  it("[error path] the generic error fallback always returns an empty roomCatalogue, never omitted/undefined", () => {
    expect(source).toMatch(/roomCatalogue: \[\], accommodationSummary: \[\] \};/);
  });

  /**
   * FOURTH PRODUCTION BUG (confirmed by real invocation of
   * resolveStayRequestFromHistory, not merely reasoned about): "je cherche
   * une chambre" -> "2 personnes" -> "il me faut une chambre pour 1
   * personne aussi" produced a full, misleadingly single-room-shaped
   * 7-entry catalogue — deterministicParty collapsed to {total:1}
   * (extractPartySize reads only the newest "N personne(s)" mention,
   * oblivious to "aussi"/additive phrasing), which is trivially compatible
   * with all 7 categories. Real invocation of resolveStayRequestFromHistory
   * against this exact conversation returned {adults:3, rooms:2} — the
   * model correctly understands two rooms even though the deterministic
   * PartySize layer cannot represent that at all. Fix: requestedRoomsCount
   * (StayRequestState.rooms, already extracted by the SAME call already
   * running on these turns — no new LLM call) suppresses the catalogue
   * outright when rooms > 1, rather than attempting to model per-room
   * occupancy (explicitly out of scope) or collapsing 2+1 into a
   * single "3 personnes" search.
   */
  describe("[multi-room hardening] requestedRoomsCount suppresses the catalogue without ever modeling per-room occupancy", () => {
    it("[wiring] requestedRoomsCount is captured from validatedState.rooms, reset to null by default, never a new LLM call", () => {
      expect(source).toMatch(/let requestedRoomsCount: number \| null = null;/);
      expect(source).toMatch(/requestedRoomsCount = validatedState\.rooms;/);
      // Captured from the SAME rawState/validatedState already produced by the single resolveStayRequestFromHistory call above it — never a second call.
      const singleCallCount = (source.match(/resolveStayRequestFromHistory\(/g) ?? []).length;
      expect(singleCallCount).toBe(1);
    });

    it("[pure logic] the gate's new term behaves exactly as specified: null or <=1 passes, >1 blocks", () => {
      function passesRoomsGate(requestedRoomsCount: number | null): boolean {
        return requestedRoomsCount === null || requestedRoomsCount <= 1;
      }
      expect(passesRoomsGate(null)).toBe(true); // unknown/not asked — the overwhelming majority of turns, unaffected
      expect(passesRoomsGate(1)).toBe(true);
      expect(passesRoomsGate(2)).toBe(false); // the exact confirmed case
      expect(passesRoomsGate(3)).toBe(false);
    });

    it("[never collapses 2+1 into 1x3] the gate suppresses the catalogue outright on a multi-room signal — it never re-filters candidates against a summed party size instead", () => {
      const gateBlock = source.slice(source.indexOf("const roomCatalogue: RoomCatalogueEntry[] ="), source.indexOf(": [];", source.indexOf("const roomCatalogue: RoomCatalogueEntry[] =")));
      // The only PartySize ever consulted for the catalogue is deterministicParty, computed once, well before requestedRoomsCount even exists — never re-derived from adults+childrenCount*rooms or similar.
      expect(gateBlock).not.toMatch(/requestedRoomsCount\s*\*/);
      expect(gateBlock).not.toMatch(/rooms\s*\*/);
    });
  });

  it("[never rewrites ROOM_DISCOVERY's own detection/continuation] isRoomDiscoveryIntent, lastAssistantMessageIndicatesRoomDiscoveryContinuation, and withRoomDiscoveryMarker are all untouched call sites — this chantier only adds a new deterministic field alongside them", () => {
    expect(source).toMatch(/const roomDiscoveryContinuationSignal = lastAssistantMessageIndicatesRoomDiscoveryContinuation\(historyInput\);/);
    expect(source).toMatch(/isRoomDiscoveryIntent\(message\)/);
    expect(source).toMatch(/withRoomDiscoveryMarker\(reply\)/);
  });
});

/**
 * AUDIT RÉGRESSION PRODUIT — les cartes de chambres ont disparu du parcours
 * réservation. Git-history-traced (51e2023) to a functional gap, not a
 * regression: roomDiscoveryIntentDetected/bookingIntentDetected have been
 * mutually exclusive since roomDiscoveryIntentDetected was introduced (a
 * decision for the PROSE/CTA layer only), long before roomCatalogue existed
 * (a604761). Gating roomCatalogue on roomDiscoveryIntentDetected alone
 * inherited that exclusion by accident, so a BOOKING conversation with a
 * fully-known party never showed the catalogue.
 *
 * SUPERSEDED/EXTENDED by the BOOKING TUNNEL chantier (isCatalogueEligibleTurn
 * is now `roomDiscoveryIntentDetected || (bookingIntentDetected &&
 * bookingReady)`, not `bookingIntentDetected` alone): a real, explicit
 * product decision — BOOKING's own catalogue must also wait for dates,
 * mirroring the reference "intention -> collecte -> propositions" tunnel,
 * while ROOM_DISCOVERY (no notion of dates at all) is completely untouched
 * and still shows the catalogue on party alone. These tests reproduce the
 * gate using the real, exported functions (isBookingIntent/isReservationIntent
 * from answer.ts, isRoomDiscoveryIntent from accommodationRanking.ts, the two
 * continuation-marker readers) — pure logic, no Supabase/OpenAI involved.
 */
describe("FIFTH/SIXTH extension — BOOKING-eligible catalogue, now gated on bookingReady (BOOKING TUNNEL chantier)", () => {
  function wouldShowCatalogueGate(
    roomDiscoveryIntentDetected: boolean,
    bookingIntentDetected: boolean,
    bookingReady: boolean,
    mentionsPreciseAccommodation: boolean,
    deterministicParty: PartySize,
    isGenuineCatalogueTurn: boolean,
    requestedRoomsCount: number | null
  ): boolean {
    const isCatalogueEligibleTurn = roomDiscoveryIntentDetected || (bookingIntentDetected && bookingReady);
    return (
      isCatalogueEligibleTurn &&
      !mentionsPreciseAccommodation &&
      isPartyKnown(deterministicParty) &&
      isGenuineCatalogueTurn &&
      (requestedRoomsCount === null || requestedRoomsCount <= 1)
    );
  }

  function computeBookingReady(stayCheckIn: string | null, stayCheckOut: string | null, deterministicParty: PartySize, requestedRoomsCount: number | null): boolean {
    return stayCheckIn !== null && stayCheckOut !== null && isPartyKnown(deterministicParty) && (requestedRoomsCount === null || requestedRoomsCount <= 1);
  }

  const partyOf2: PartySize = { adults: null, children: null, total: 2 };
  const partyOf6: PartySize = { adults: null, children: null, total: 6 };
  const unknownParty: PartySize = { adults: null, children: null, total: null };

  it("[1. BOOKING sans rien] bookingIntentDetected seul, ni dates ni party -> pas de catalogue", () => {
    const bookingReady = computeBookingReady(null, null, unknownParty, null);
    expect(bookingReady).toBe(false);
    expect(wouldShowCatalogueGate(false, true, bookingReady, false, unknownParty, true, null)).toBe(false);
  });

  it("[1b. BOOKING party connue, dates inconnues] Option 2 — le catalogue attend AUSSI les dates, pas seulement la party", () => {
    // Exactement le scénario B de l'AUDIT PHASE 1 : "Je veux réserver une chambre pour 2 personnes".
    const bookingReady = computeBookingReady(null, null, partyOf2, null);
    expect(bookingReady).toBe(false);
    expect(wouldShowCatalogueGate(false, true, bookingReady, false, partyOf2, true, null)).toBe(false);
  });

  it("[1c. BOOKING dates connues, party inconnue] symétrique — le catalogue attend aussi la party", () => {
    // Exactement le scénario C de l'AUDIT PHASE 1 : "Je veux réserver du 22 au 24 septembre".
    const bookingReady = computeBookingReady("2026-09-22", "2026-09-24", unknownParty, null);
    expect(bookingReady).toBe(false);
    expect(wouldShowCatalogueGate(false, true, bookingReady, false, unknownParty, true, null)).toBe(false);
  });

  it("[2. LE TEST PRINCIPAL — BOOKING continuation] 'je veux réserver une chambre' puis 'du 22 au 24 septembre pour 2 personnes' -> catalogue affiché (dates ET party désormais connues)", () => {
    // Turn 2: isBookingIntent("du 22 au 24 septembre pour 2 personnes") is false (no booking
    // keyword), but the continuation marker set on turn 1's reply keeps bookingIntentDetected
    // true. messageAloneStatesPartySize is true (the message itself states "2 personnes").
    const message = "du 22 au 24 septembre pour 2 personnes";
    expect(isBookingIntent(message)).toBe(false);
    const historyAfterTurn1 = [{ role: "assistant" as const, content: withBookingIntentMarker("Quelles sont vos dates et pour combien de personnes ?") }];
    expect(lastAssistantMessageIndicatesBookingIntent(historyAfterTurn1)).toBe(true);
    const roomDiscoveryIntentDetected = isRoomDiscoveryIntent(message) || lastAssistantMessageIndicatesRoomDiscoveryContinuation(historyAfterTurn1);
    expect(roomDiscoveryIntentDetected).toBe(false);
    const bookingIntentDetected = !roomDiscoveryIntentDetected && (isBookingIntent(message) || lastAssistantMessageIndicatesBookingIntent(historyAfterTurn1));
    expect(bookingIntentDetected).toBe(true);
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || isPartyKnown(extractPartySize(message));
    expect(isGenuineCatalogueTurn).toBe(true);
    // Dates resolved by resolveStayRequestFromHistory (real invocation confirmed 15/15 in the BOOKING TUNNEL audit) — represented here deterministically since this file never calls OpenAI.
    const bookingReady = computeBookingReady("2026-09-22", "2026-09-24", partyOf2, null);
    expect(bookingReady).toBe(true);

    expect(wouldShowCatalogueGate(roomDiscoveryIntentDetected, bookingIntentDetected, bookingReady, false, partyOf2, isGenuineCatalogueTurn, null)).toBe(true);
  });

  it("[3. BOOKING single-shot] 'je veux réserver une chambre du 22 au 24 septembre pour 2 personnes' en un seul message -> catalogue affiché", () => {
    const message = "je veux réserver une chambre du 22 au 24 septembre pour 2 personnes";
    expect(isBookingIntent(message)).toBe(true);
    const bookingIntentDetected = !isRoomDiscoveryIntent(message) && isBookingIntent(message);
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || isPartyKnown(extractPartySize(message));
    const bookingReady = computeBookingReady("2026-09-22", "2026-09-24", partyOf2, null);
    expect(wouldShowCatalogueGate(false, bookingIntentDetected, bookingReady, false, partyOf2, isGenuineCatalogueTurn, null)).toBe(true);
  });

  it("[4. BOOKING 6 personnes] même flux avec un groupe de 6, dates connues -> catalogue limité par la capacité (résolu en amont par catalogueRankedCandidates, hors du gate lui-même)", () => {
    const message = "du 22 au 24 septembre pour 6 personnes";
    const historyAfterTurn1 = [{ role: "assistant" as const, content: withBookingIntentMarker("Pour combien de personnes ?") }];
    const bookingIntentDetected = !isRoomDiscoveryIntent(message) && lastAssistantMessageIndicatesBookingIntent(historyAfterTurn1);
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || isPartyKnown(extractPartySize(message));
    const bookingReady = computeBookingReady("2026-09-22", "2026-09-24", partyOf6, null);
    expect(wouldShowCatalogueGate(false, bookingIntentDetected, bookingReady, false, partyOf6, isGenuineCatalogueTurn, null)).toBe(true);
    // The gate itself doesn't filter by capacity — catalogueRankedCandidates (filterAndRankAccommodations) does that separately, already covered by CAS 3 above.
  });

  it("[5. BOOKING établie + 'merci'] une fois dates+party connues, un message sans rapport ne réaffiche pas le catalogue", () => {
    const message = "merci";
    const historyAfterTurn2 = [{ role: "assistant" as const, content: withBookingIntentMarker("Votre réservation est en cours de préparation.") }];
    const roomDiscoveryIntentDetected = isRoomDiscoveryIntent(message) || lastAssistantMessageIndicatesRoomDiscoveryContinuation(historyAfterTurn2);
    const bookingIntentDetected = !roomDiscoveryIntentDetected && (isBookingIntent(message) || lastAssistantMessageIndicatesBookingIntent(historyAfterTurn2));
    expect(bookingIntentDetected).toBe(true); // continuation marker still live
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || isPartyKnown(extractPartySize(message));
    expect(isGenuineCatalogueTurn).toBe(false); // "merci" alone states no party size and isn't a discovery phrasing
    const bookingReady = computeBookingReady("2026-09-22", "2026-09-24", partyOf2, null); // even fully ready...
    expect(wouldShowCatalogueGate(roomDiscoveryIntentDetected, bookingIntentDetected, bookingReady, false, partyOf2, isGenuineCatalogueTurn, null)).toBe(false); // ...isGenuineCatalogueTurn still blocks it
  });

  it("[6. BOOKING établie + 'bonjour']  même protection pour un autre message hors-sujet", () => {
    const message = "bonjour";
    const historyAfterTurn2 = [{ role: "assistant" as const, content: withBookingIntentMarker("Votre réservation est en cours de préparation.") }];
    const bookingIntentDetected = !isRoomDiscoveryIntent(message) && (isBookingIntent(message) || lastAssistantMessageIndicatesBookingIntent(historyAfterTurn2));
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || isPartyKnown(extractPartySize(message));
    const bookingReady = computeBookingReady("2026-09-22", "2026-09-24", partyOf2, null);
    expect(wouldShowCatalogueGate(false, bookingIntentDetected, bookingReady, false, partyOf2, isGenuineCatalogueTurn, null)).toBe(false);
  });

  it("[7. BOOKING multi-chambres] requestedRoomsCount > 1 supprime le catalogue (et bookingReady lui-même) même en contexte booking, sans jamais modéliser l'occupation par chambre", () => {
    const message = "du 22 au 24 septembre, 2 chambres pour 3 personnes";
    const bookingIntentDetected = !isRoomDiscoveryIntent(message) && isBookingIntent(message);
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || isPartyKnown(extractPartySize(message));
    const bookingReady = computeBookingReady("2026-09-22", "2026-09-24", partyOf2, 2);
    expect(bookingReady).toBe(false); // multi-room alone suffices to keep bookingReady false
    expect(wouldShowCatalogueGate(false, bookingIntentDetected, bookingReady, false, partyOf2, isGenuineCatalogueTurn, 2)).toBe(false);
  });

  it("[8. ROOM_DISCOVERY 2 personnes, non-régression] le flux room-discovery historique continue de fonctionner à l'identique — jamais gaté sur bookingReady/les dates", () => {
    const message = "2 personnes";
    const historyAfterTurn1 = [{ role: "assistant" as const, content: "Combien de personnes ?" }];
    const roomDiscoveryIntentDetected = isRoomDiscoveryIntent("je cherche une chambre") || lastAssistantMessageIndicatesRoomDiscoveryContinuation(historyAfterTurn1);
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || isPartyKnown(extractPartySize(message));
    // bookingReady stays false (no dates ever asked for ROOM_DISCOVERY) — irrelevant, since roomDiscoveryIntentDetected alone satisfies isCatalogueEligibleTurn.
    expect(wouldShowCatalogueGate(roomDiscoveryIntentDetected || isRoomDiscoveryIntent("je cherche une chambre"), false, false, false, partyOf2, isGenuineCatalogueTurn, null)).toBe(true);
  });

  it("[9. ROOM_DISCOVERY 6 personnes, non-régression] toujours filtré par capacité via catalogueRankedCandidates, jamais par le gate lui-même, jamais par bookingReady", () => {
    const isGenuineCatalogueTurn = isRoomDiscoveryIntent("je cherche une chambre pour 6 personnes") || isPartyKnown(extractPartySize("je cherche une chambre pour 6 personnes"));
    expect(wouldShowCatalogueGate(true, false, false, false, partyOf6, isGenuineCatalogueTurn, null)).toBe(true);
  });

  it("[10. sélection précise, non-régression] mentionsPreciseAccommodation bloque le catalogue quel que soit le flux (room-discovery ou booking), même bookingReady", () => {
    expect(wouldShowCatalogueGate(true, false, false, true, partyOf2, true, null)).toBe(false);
    expect(wouldShowCatalogueGate(false, true, true, true, partyOf2, true, null)).toBe(false);
  });

  it("[wiring] bookingIntentDetected's own formula/semantics are completely unchanged by being moved earlier — still !roomDiscoveryIntentDetected && (isBookingIntent || continuation), never touched", () => {
    const bookingIntentStart = source.indexOf("const bookingIntentDetected =");
    expect(source.slice(bookingIntentStart, bookingIntentStart + 200)).toMatch(
      /const bookingIntentDetected =\s*\n\s*!roomDiscoveryIntentDetected && \(isBookingIntent\(message\) \|\| lastAssistantMessageIndicatesBookingIntent\(historyInput\)\);/
    );
  });

  it("[wiring] bookingReady is exposed via stayCheckIn/stayCheckOut, captured from the SAME already-running resolveStayRequestFromHistory call as requestedRoomsCount — no new LLM call", () => {
    expect(source).toMatch(/let stayCheckIn: string \| null = null;/);
    expect(source).toMatch(/let stayCheckOut: string \| null = null;/);
    expect(source).toMatch(/stayCheckIn = validatedState\.checkIn;/);
    expect(source).toMatch(/stayCheckOut = validatedState\.checkOut;/);
    expect(source).toMatch(
      /const bookingReady =\s*\n\s*stayCheckIn !== null && stayCheckOut !== null && isPartyKnown\(deterministicParty\) && \(requestedRoomsCount === null \|\| requestedRoomsCount <= 1\);/
    );
  });
});

/**
 * BOOKING TUNNEL chantier — protecting the existing, deliberately broad
 * isBookingIntent/isAvailabilityRequest behavior for a standalone
 * price/availability question: the user explicitly rejected an implicit
 * regression here (a bare price/availability question must keep showing the
 * CTA immediately, exactly as before — see answer.groundingMode.test.ts's
 * own [BOOKING TUNNEL chantier] test for the CTA side of this guarantee).
 * isReservationIntent is a strict, narrower subset of the patterns
 * isAvailabilityRequest already covers — never a new detection mechanism.
 */
describe("isReservationIntent — narrower than isBookingIntent, protects price/availability-only behavior", () => {
  it("[genuine reservation attempts] matches réserver/réservation/book/booking", () => {
    expect(isReservationIntent("Je veux réserver une chambre")).toBe(true);
    expect(isReservationIntent("je veus reserver une chambre")).toBe(true); // accent-insensitive regex, same as isAvailabilityRequest's own
    expect(isReservationIntent("I'd like to book a room")).toBe(true);
    expect(isReservationIntent("what's your booking policy?")).toBe(true);
  });

  it("[price question alone] never matches — isBookingIntent still does (unchanged, see bookingAction.test.ts)", () => {
    expect(isReservationIntent("Quel est le tarif de la Deluxe ?")).toBe(false);
    expect(isReservationIntent("Combien coûte une nuit ?")).toBe(false);
    expect(isBookingIntent("Quel est le tarif de la Deluxe ?")).toBe(true);
  });

  it("[availability question alone] never matches — isBookingIntent/isAvailabilityRequest still do (unchanged)", () => {
    expect(isReservationIntent("C'est disponible ce week-end ?")).toBe(false);
    expect(isReservationIntent("Il y a de la disponibilité pour ce week-end ?")).toBe(false);
    expect(isBookingIntent("C'est disponible ce week-end ?")).toBe(true);
  });

  it("[reservationCollectionActive never fires for a standalone price/availability question] reservationIntentDetected requires isReservationIntent OR the SAME continuation marker as bookingIntentDetected — a fresh price/availability message with no prior marker is false either way", () => {
    const priceMessage = "Quel est le tarif de la Deluxe ?";
    // Deliberately avoids "chambres"/"avez-vous" wording, which ROOM_DISCOVERY's own isRoomDiscoveryIntent
    // would also match (an existing, unrelated precedence rule — roomDiscoveryIntentDetected already takes
    // priority over bookingIntentDetected for THAT case, see roomDiscoveryIntentDetected's own doc comment) —
    // this test is specifically about the price/availability-vs-reservation distinction, not that one.
    const availabilityMessage = "C'est disponible ce week-end ?";
    for (const message of [priceMessage, availabilityMessage]) {
      const roomDiscoveryIntentDetected = isRoomDiscoveryIntent(message);
      const reservationIntentDetected = !roomDiscoveryIntentDetected && (isReservationIntent(message) || lastAssistantMessageIndicatesBookingIntent([]));
      expect(reservationIntentDetected).toBe(false);
      // bookingIntentDetected (the existing, broad flag) is still true — the CTA-driving flag is untouched.
      const bookingIntentDetected = !roomDiscoveryIntentDetected && (isBookingIntent(message) || lastAssistantMessageIndicatesBookingIntent([]));
      expect(bookingIntentDetected).toBe(true);
    }
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
