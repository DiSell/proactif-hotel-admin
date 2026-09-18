import { describe, expect, it } from "vitest";
import {
  containsMonetaryAmount,
  containsUnauthorizedMonetaryAmount,
  extractMonetaryAmounts,
  isPriceCommunicationAllowed,
  redactMonetaryAmounts,
  PRICE_LOCKED_FALLBACK_REPLY,
} from "./pricePolicy";
import type { ChatbotSettings } from "@/types/database";

function settings(overrides: Partial<ChatbotSettings> = {}): ChatbotSettings {
  return {
    id: "settings-a",
    hotel_id: "hotel-a",
    welcome_message: null,
    fallback_message: null,
    handoff_email: null,
    handoff_phone: null,
    tone: "warm",
    formality: "vous",
    response_length: "normal",
    commercial_proactivity: "discreet",
    custom_instructions: null,
    allow_price_communication: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("isPriceCommunicationAllowed", () => {
  it("[migration-safe default] a null settings row (hotel never configured it) is closed, never open", () => {
    expect(isPriceCommunicationAllowed(null)).toBe(false);
  });

  it("undefined settings is also closed", () => {
    expect(isPriceCommunicationAllowed(undefined)).toBe(false);
  });

  it("explicit false is closed", () => {
    expect(isPriceCommunicationAllowed(settings({ allow_price_communication: false }))).toBe(false);
  });

  it("explicit true is open", () => {
    expect(isPriceCommunicationAllowed(settings({ allow_price_communication: true }))).toBe(true);
  });
});

/**
 * The detector matrix explicitly required for this chantier: every real
 * currency variant tested individually, and every non-monetary number type
 * (surfaces, capacities, dates, times, room numbers) proven to survive
 * untouched — the exact distinction the whole policy depends on.
 */
describe("containsMonetaryAmount", () => {
  it.each([
    "288 €",
    "288€",
    "€288",
    "€ 288",
    "288,00 €",
    "288.00 EUR",
    "288.00€",
    "288 euros",
    "288 EUR",
    "à partir de 185€",
    "185 € / nuit",
    "274 €",
    "Prix : 190,50 €.",
    "$150",
    "150 USD",
    "£99",
  ])("[positive] detects a monetary amount in: %s", (text) => {
    expect(containsMonetaryAmount(text)).toBe(true);
  });

  it.each([
    "45 m²",
    "4 personnes",
    "22 septembre",
    "10h30",
    "chambre 288",
    "1 - 4 persons",
    "du 20 au 22 septembre",
    "60 m², deux chambres",
    "2 adultes et 1 enfant",
    "la Deluxe fait 45 m² et accueille 4 personnes",
    "",
    "Aucune information tarifaire ici.",
  ])("[negative] never flags a non-monetary number in: %s", (text) => {
    expect(containsMonetaryAmount(text)).toBe(false);
  });
});

describe("redactMonetaryAmounts", () => {
  it("[the worked example] preserves surface and amenities, redacts only the price, in the same sentence", () => {
    const input = "Deluxe — 45 m² — climatisation — 288 € la nuit pour 2 pers.";
    const result = redactMonetaryAmounts(input);
    expect(result).toContain("45 m²");
    expect(result).toContain("climatisation");
    expect(result).not.toContain("288 €");
    expect(containsMonetaryAmount(result)).toBe(false);
  });

  it("[real chunk text] redacts the price from an actual Deluxe-shaped chunk while keeping the description intact", () => {
    const input =
      "The Deluxe Suite can accommodate up to 4 people. ... reversible air conditioning in summer, linen provided and a free WIFI internet connection.\n288 € la nuit pour 2 pers.";
    const result = redactMonetaryAmounts(input);
    expect(result).toContain("reversible air conditioning");
    expect(result).toContain("accommodate up to 4 people");
    expect(containsMonetaryAmount(result)).toBe(false);
  });

  it("[no monetary content] leaves the text byte-for-byte unchanged", () => {
    const input = "La Deluxe fait 45 m² et dispose de la climatisation réversible.";
    expect(redactMonetaryAmounts(input)).toBe(input);
  });

  it("[multiple amounts in the same text] redacts every occurrence, not just the first", () => {
    const input = "Deluxe : 288 €. Deluxe PMR : 288 €. Superior : 248 €.";
    const result = redactMonetaryAmounts(input);
    expect(containsMonetaryAmount(result)).toBe(false);
    expect(result).not.toContain("288");
    expect(result).not.toContain("248");
  });

  it("[repeated calls never drift — no stateful regex bug] calling containsMonetaryAmount/redactMonetaryAmounts many times in a row gives identical results every time", () => {
    const withPrice = "288 €";
    const withoutPrice = "45 m²";
    for (let i = 0; i < 5; i++) {
      expect(containsMonetaryAmount(withPrice)).toBe(true);
      expect(containsMonetaryAmount(withoutPrice)).toBe(false);
    }
  });
});

describe("PRICE_LOCKED_FALLBACK_REPLY", () => {
  it("is itself never flagged as containing a monetary amount", () => {
    expect(containsMonetaryAmount(PRICE_LOCKED_FALLBACK_REPLY)).toBe(false);
  });
});

/**
 * The certified-source model's actual comparison primitive:
 * canCommunicatePrice = hotelAllowsPriceCommunication && priceIsCertified.
 * extractMonetaryAmounts is the "read the real value" half;
 * containsUnauthorizedMonetaryAmount is the comparison the output-side lock
 * actually runs.
 */
describe("extractMonetaryAmounts", () => {
  it("[normalizes every real format to the same number] 288, 288,00, and 288.00 all extract to 288", () => {
    expect(extractMonetaryAmounts("288 €")).toEqual([288]);
    expect(extractMonetaryAmounts("288,00 €")).toEqual([288]);
    expect(extractMonetaryAmounts("288.00 EUR")).toEqual([288]);
    expect(extractMonetaryAmounts("€288")).toEqual([288]);
  });

  it("[multiple amounts, in order] a text with several monetary expressions yields every value, in the order they appear", () => {
    expect(extractMonetaryAmounts("Le spa coûte 50 € et la Deluxe coûte 288 €.")).toEqual([50, 288]);
  });

  it("[no amounts] returns an empty array, never null/undefined", () => {
    expect(extractMonetaryAmounts("La Deluxe fait 45 m² et accueille 4 personnes.")).toEqual([]);
  });

  it("[non-monetary numbers never extracted] surfaces/capacities/dates/times are never mistaken for amounts", () => {
    expect(extractMonetaryAmounts("45 m², 4 personnes, 22 septembre, 10h30")).toEqual([]);
  });
});

describe("containsUnauthorizedMonetaryAmount", () => {
  it("[nothing detected] a reply with no monetary amount at all is never unauthorized, regardless of authorizedAmounts", () => {
    expect(containsUnauthorizedMonetaryAmount("La Deluxe fait 45 m².", [])).toBe(false);
    expect(containsUnauthorizedMonetaryAmount("La Deluxe fait 45 m².", [50])).toBe(false);
  });

  it("[OFF-equivalent] any detected amount is unauthorized when authorizedAmounts is empty", () => {
    expect(containsUnauthorizedMonetaryAmount("La Deluxe est à 288 €.", [])).toBe(true);
  });

  it("[exact certified match] an amount that IS in authorizedAmounts is never unauthorized", () => {
    expect(containsUnauthorizedMonetaryAmount("Le spa coûte 50 €.", [50])).toBe(false);
  });

  it("[format-insensitive certified match] 50,00 € and 50.00 EUR both match a certified [50]", () => {
    expect(containsUnauthorizedMonetaryAmount("Le spa coûte 50,00 €.", [50])).toBe(false);
    expect(containsUnauthorizedMonetaryAmount("Le spa coûte 50.00 EUR.", [50])).toBe(false);
  });

  it("[near-miss is still unauthorized] 60 € is never treated as a match for a certified 50", () => {
    expect(containsUnauthorizedMonetaryAmount("Le spa coûte 60 €.", [50])).toBe(true);
  });

  it("[CAS CRITIQUE — mixed reply] a certified 50 € alongside an uncertified 288 € in the SAME text is unauthorized as a whole — one bad amount is enough", () => {
    expect(containsUnauthorizedMonetaryAmount("Le spa coûte 50 € et la Deluxe coûte 288 €.", [50])).toBe(true);
  });

  it("[several certified amounts] a reply mentioning two DIFFERENT certified amounts is authorized", () => {
    expect(containsUnauthorizedMonetaryAmount("Adultes : 50 €, enfants : 25 €.", [50, 25])).toBe(false);
  });

  it("[model cannot self-certify] the model producing the exact right-looking amount for a source that was never actually certified this turn is still unauthorized — the server's own authorizedAmounts list is the only source of truth", () => {
    // Simulates a hallucinated/uncertified "50 €" appearing even though nothing certified it this turn:
    expect(containsUnauthorizedMonetaryAmount("Cela coûte 50 €.", [])).toBe(true);
  });
});
