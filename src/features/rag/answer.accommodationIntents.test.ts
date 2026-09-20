import { describe, it, expect } from "vitest";
import {
  isRoomDiscoveryIntent,
  isAccommodationInformationIntent,
  isAccommodationRecommendationIntent,
  shouldAskPartySizeOnly,
  findMentionedAccommodation,
} from "./accommodationRanking";

/**
 * 3-INTENTIONS chantier ("AUDIT INTENTIONS HÉBERGEMENTS" -> "IMPLÉMENTER LES
 * 3 INTENTIONS HÉBERGEMENT"). Reproduces the mission's own A-H test matrix
 * and its two mandated continuation scenarios (item 8), using the real,
 * exported detectors (never Le 1837-specific — ACCOMMODATIONS below is a
 * generic fixture, not hardcoded hotel data). See accommodationRanking.test.ts
 * for the detectors' own unit tests, answer.roomCatalogue.test.ts for
 * roomCatalogue's own gate wiring, and prompt.test.ts for
 * accommodationGuidance's no_context coverage (message H).
 */
import { extractPartySize, isPartyKnown } from "./partySize";
import { isBookingIntent } from "./answer";
import { lastAssistantMessageIndicatesRoomDiscoveryContinuation } from "./roomDiscoveryContinuation";
import { lastAssistantMessageIndicatesRecommendationContinuation, withRecommendationMarker } from "./recommendationContinuation";

const ACCOMMODATIONS = [
  { id: "1", name: "Mini-suite", sourceUrl: null },
  { id: "2", name: "Standard", sourceUrl: null },
  { id: "3", name: "Superior", sourceUrl: null },
  { id: "4", name: "Deluxe", sourceUrl: null },
  { id: "5", name: "Deluxe PMR", sourceUrl: null },
  { id: "6", name: "Junior Suite", sourceUrl: null },
  { id: "7", name: "Junior PMR", sourceUrl: null },
];

const MESSAGES: Record<string, string> = {
  A: "Quels types de chambres ou logements proposez-vous ?",
  B: "Quels sont vos types d'appartements ?",
  C: "Vous proposez quoi comme hébergements ?",
  D: "Montrez-moi vos logements.",
  E: "Je veux voir vos chambres.",
  F: "Quel logement me conseillez-vous ?",
  G: "Nous sommes 4, quel logement conseillez-vous ?",
  H: "Nous sommes 6, que proposez-vous ?",
};

describe("MISSION - matrice A-H (implementation)", () => {
  for (const [label, message] of Object.entries(MESSAGES)) {
    it(`[${label}] "${message}"`, () => {
      const mentioned = findMentionedAccommodation(message, ACCOMMODATIONS);
      const mentionsPrecise = mentioned !== null;
      const information = isAccommodationInformationIntent(message);
      const catalogue = isRoomDiscoveryIntent(message);
      const recommendation = isAccommodationRecommendationIntent(message);
      const party = extractPartySize(message);
      const askPartySizeOnly = shouldAskPartySizeOnly(recommendation, mentionsPrecise, party);
      console.log(
        `[${label}] information=${information} catalogue=${catalogue} recommendation=${recommendation} partyKnown=${isPartyKnown(party)} askPartySizeOnly=${askPartySizeOnly}`
      );
    });
  }

  it("[A] information, no party question, no catalogue", () => {
    expect(isAccommodationInformationIntent(MESSAGES.A)).toBe(true);
    expect(isRoomDiscoveryIntent(MESSAGES.A)).toBe(false);
    expect(isAccommodationRecommendationIntent(MESSAGES.A)).toBe(false);
    expect(shouldAskPartySizeOnly(isAccommodationRecommendationIntent(MESSAGES.A), false, extractPartySize(MESSAGES.A))).toBe(false);
  });

  it("[B] information", () => {
    expect(isAccommodationInformationIntent(MESSAGES.B)).toBe(true);
    expect(isRoomDiscoveryIntent(MESSAGES.B)).toBe(false);
  });

  it("[C] information", () => {
    expect(isAccommodationInformationIntent(MESSAGES.C)).toBe(true);
    expect(isRoomDiscoveryIntent(MESSAGES.C)).toBe(false);
  });

  it("[D] catalogue, no party question, roomCatalogue-eligible", () => {
    expect(isRoomDiscoveryIntent(MESSAGES.D)).toBe(true);
    expect(isAccommodationRecommendationIntent(MESSAGES.D)).toBe(false);
    expect(shouldAskPartySizeOnly(isAccommodationRecommendationIntent(MESSAGES.D), false, extractPartySize(MESSAGES.D))).toBe(false);
  });

  it("[E] catalogue, no party question", () => {
    expect(isRoomDiscoveryIntent(MESSAGES.E)).toBe(true);
    expect(shouldAskPartySizeOnly(isAccommodationRecommendationIntent(MESSAGES.E), false, extractPartySize(MESSAGES.E))).toBe(false);
  });

  it("[F] recommendation, party unknown -> asks capacity", () => {
    expect(isAccommodationRecommendationIntent(MESSAGES.F)).toBe(true);
    expect(isRoomDiscoveryIntent(MESSAGES.F)).toBe(false);
    expect(isPartyKnown(extractPartySize(MESSAGES.F))).toBe(false);
    expect(shouldAskPartySizeOnly(true, false, extractPartySize(MESSAGES.F))).toBe(true);
  });

  it("[G] recommendation, party=4 stated this turn -> never re-asks", () => {
    const party = extractPartySize(MESSAGES.G);
    expect(isPartyKnown(party)).toBe(true);
    expect(party.total).toBe(4);
    expect(isAccommodationRecommendationIntent(MESSAGES.G)).toBe(true);
    expect(shouldAskPartySizeOnly(true, false, party)).toBe(false);
  });

  it("[H] structured data path - party known, no capacity question, no invented text (asserted at the prompt.ts level separately)", () => {
    const party = extractPartySize(MESSAGES.H);
    expect(isPartyKnown(party)).toBe(true);
    expect(party.total).toBe(6);
    expect(isAccommodationRecommendationIntent(MESSAGES.H)).toBe(false);
    expect(isRoomDiscoveryIntent(MESSAGES.H)).toBe(false);
  });
});

describe("MISSION - continuation scenarios (item 7)", () => {
  it("[INFORMATION continuation] Tour1 'Quels types de logements proposez-vous ?' -> Tour2 'Je veux simplement connaitre votre offre.' stays INFORMATION at both turns", () => {
    const t1Message = "Quels types de logements proposez-vous ?";
    expect(isAccommodationInformationIntent(t1Message)).toBe(true);
    expect(isRoomDiscoveryIntent(t1Message)).toBe(false);
    expect(isAccommodationRecommendationIntent(t1Message)).toBe(false);
    const t1Reply = "Voici nos categories : ...";
    const history = [
      { role: "user" as const, content: t1Message },
      { role: "assistant" as const, content: t1Reply },
    ];
    expect(lastAssistantMessageIndicatesRoomDiscoveryContinuation(history)).toBe(false);
    expect(lastAssistantMessageIndicatesRecommendationContinuation(history)).toBe(false);

    const t2Message = "Je veux simplement connaitre votre offre.";
    const roomDiscoveryContinuationSignal = lastAssistantMessageIndicatesRoomDiscoveryContinuation(history);
    const roomDiscoveryIntentDetected = isRoomDiscoveryIntent(t2Message) || (roomDiscoveryContinuationSignal && !isBookingIntent(t2Message));
    const recommendationContinuationSignal = lastAssistantMessageIndicatesRecommendationContinuation(history);
    const recommendationIntentDetected =
      !roomDiscoveryIntentDetected &&
      (isAccommodationRecommendationIntent(t2Message) || (recommendationContinuationSignal && !isBookingIntent(t2Message)));
    expect(roomDiscoveryIntentDetected).toBe(false);
    expect(recommendationIntentDetected).toBe(false);
    expect(shouldAskPartySizeOnly(recommendationIntentDetected, false, extractPartySize(t2Message))).toBe(false);
  });

  it("[RECOMMENDATION continuation] Tour1 'Quel logement me conseillez-vous ?' (asks capacity) -> Tour2 'Nous sommes 4.' continues as RECOMMENDATION, never re-asks", () => {
    const t1Message = "Quel logement me conseillez-vous ?";
    expect(isAccommodationRecommendationIntent(t1Message)).toBe(true);
    const t1AskPartySizeOnly = shouldAskPartySizeOnly(true, false, extractPartySize(t1Message));
    expect(t1AskPartySizeOnly).toBe(true);
    const t1Reply = withRecommendationMarker("Combien de personnes sejourneraient dans votre groupe ?");
    const history = [
      { role: "user" as const, content: t1Message },
      { role: "assistant" as const, content: t1Reply },
    ];
    expect(lastAssistantMessageIndicatesRecommendationContinuation(history)).toBe(true);

    const t2Message = "Nous sommes 4.";
    expect(isAccommodationRecommendationIntent(t2Message)).toBe(false);
    const roomDiscoveryIntentDetected = isRoomDiscoveryIntent(t2Message);
    expect(roomDiscoveryIntentDetected).toBe(false);
    const recommendationContinuationSignal = lastAssistantMessageIndicatesRecommendationContinuation(history);
    const recommendationIntentDetected =
      !roomDiscoveryIntentDetected &&
      (isAccommodationRecommendationIntent(t2Message) || (recommendationContinuationSignal && !isBookingIntent(t2Message)));
    expect(recommendationIntentDetected).toBe(true);
    const party = extractPartySize(t2Message);
    expect(isPartyKnown(party)).toBe(true);
    expect(party.total).toBe(4);
    expect(shouldAskPartySizeOnly(recommendationIntentDetected, false, party)).toBe(false);
  });
});
