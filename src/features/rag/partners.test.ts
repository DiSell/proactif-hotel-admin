import { describe, expect, it } from "vitest";
import {
  ALL_PARTNERS_LIMIT,
  DEFAULT_PARTNER_LIMIT,
  buildPartnerAction,
  detectRelevantPartnerCategory,
  isPartnerIntent,
  rankPartnerCandidates,
  toPartnerRecommendation,
  wantsAllPartners,
} from "./partners";
import type { HotelPartner, HotelPartnerCategory } from "@/types/database";

function partner(overrides: Partial<HotelPartner> & { id: string; name: string; category: HotelPartnerCategory }): HotelPartner {
  return {
    hotel_id: "hotel-a",
    description: null,
    address: null,
    phone: null,
    opening_hours: null,
    email: null,
    website_url: null,
    booking_url: null,
    consent_status: "accepted",
    consent_requested_at: null,
    consent_responded_at: null,
    is_active: true,
    priority: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("isPartnerIntent", () => {
  it("[restaurant, FR] 'Vous connaissez un bon restaurant ?' is detected", () => {
    expect(isPartnerIntent("Vous connaissez un bon restaurant ?")).toBe(true);
  });

  it("[transport, FR] 'Comment aller à la gare ?' is detected", () => {
    expect(isPartnerIntent("Comment aller à la gare ?")).toBe(true);
  });

  it("[taxi, FR] 'Vous avez un taxi à recommander ?' is detected", () => {
    expect(isPartnerIntent("Vous avez un taxi à recommander ?")).toBe(true);
  });

  it("[activity, FR] 'Que peut-on faire autour de l'hôtel ?' is detected", () => {
    expect(isPartnerIntent("Que peut-on faire autour de l'hôtel ?")).toBe(true);
  });

  it("[rental, FR] 'Où louer des vélos ?' is detected", () => {
    expect(isPartnerIntent("Où louer des vélos ?")).toBe(true);
  });

  it("[EN] 'Can you recommend a restaurant?' is detected", () => {
    expect(isPartnerIntent("Can you recommend a restaurant?")).toBe(true);
  });

  it("[no partner intent] a plain accommodation question is not flagged", () => {
    expect(isPartnerIntent("Quelle est la capacité de la suite familiale ?")).toBe(false);
  });

  it("[no partner intent] a greeting is not flagged", () => {
    expect(isPartnerIntent("Bonjour")).toBe(false);
  });
});

describe("detectRelevantPartnerCategory", () => {
  it("[restaurant] 'un bon restaurant' -> restaurant", () => {
    expect(detectRelevantPartnerCategory("Vous connaissez un bon restaurant ?")).toBe("restaurant");
  });

  it("[transport] 'un taxi' -> transport", () => {
    expect(detectRelevantPartnerCategory("Vous avez un taxi à recommander ?")).toBe("transport");
  });

  it("[rental] 'louer des vélos' -> rental", () => {
    expect(detectRelevantPartnerCategory("Où louer des vélos ?")).toBe("rental");
  });

  it("[no specific category] a generic 'que peut-on faire autour de l'hôtel' returns null", () => {
    expect(detectRelevantPartnerCategory("Que peut-on faire autour de l'hôtel ?")).toBeNull();
  });
});

describe("wantsAllPartners", () => {
  it("[explicit all, FR] 'quels sont tous vos restaurants partenaires ?' is detected", () => {
    expect(wantsAllPartners("Quels sont tous vos restaurants partenaires ?")).toBe(true);
  });

  it("[not explicit] 'vous connaissez un bon restaurant ?' is not an 'all' request", () => {
    expect(wantsAllPartners("Vous connaissez un bon restaurant ?")).toBe(false);
  });
});

describe("rankPartnerCandidates", () => {
  it("[priority DESC then name ASC] ordering respects priority first, name as tie-breaker", () => {
    const partners = [
      partner({ id: "1", name: "Zebra", category: "restaurant", priority: 5 }),
      partner({ id: "2", name: "Alpha", category: "restaurant", priority: 10 }),
      partner({ id: "3", name: "Beta", category: "restaurant", priority: 10 }),
    ];
    const ranked = rankPartnerCandidates(partners, { category: null, limit: DEFAULT_PARTNER_LIMIT });
    expect(ranked.map((p) => p.id)).toEqual(["2", "3", "1"]);
  });

  it("[inactive never recommended] an inactive partner is excluded even with the highest priority", () => {
    const partners = [
      partner({ id: "1", name: "Actif", category: "restaurant", priority: 1, is_active: true }),
      partner({ id: "2", name: "Inactif", category: "restaurant", priority: 999, is_active: false }),
    ];
    const ranked = rankPartnerCandidates(partners, { category: null, limit: DEFAULT_PARTNER_LIMIT });
    expect(ranked.map((p) => p.id)).toEqual(["1"]);
  });

  it("[max 3 by default] more than DEFAULT_PARTNER_LIMIT active partners are capped", () => {
    const partners = Array.from({ length: 10 }, (_, i) => partner({ id: `p${i}`, name: `Partner ${i}`, category: "restaurant", priority: i }));
    const ranked = rankPartnerCandidates(partners, { category: null, limit: DEFAULT_PARTNER_LIMIT });
    expect(ranked).toHaveLength(3);
  });

  it("[explicit 'all' raises the cap] ALL_PARTNERS_LIMIT allows more than 3", () => {
    const partners = Array.from({ length: 10 }, (_, i) => partner({ id: `p${i}`, name: `Partner ${i}`, category: "restaurant", priority: i }));
    const ranked = rankPartnerCandidates(partners, { category: null, limit: ALL_PARTNERS_LIMIT });
    expect(ranked).toHaveLength(10);
  });

  it("[category filter applied] only the matching category is returned when at least one active match exists", () => {
    const partners = [
      partner({ id: "1", name: "Restaurant A", category: "restaurant" }),
      partner({ id: "2", name: "Taxi B", category: "transport" }),
    ];
    const ranked = rankPartnerCandidates(partners, { category: "restaurant", limit: DEFAULT_PARTNER_LIMIT });
    expect(ranked.map((p) => p.id)).toEqual(["1"]);
  });

  it("[category miss falls back to all] a detected category with zero matching active partners falls back to the full active pool, never an empty result", () => {
    const partners = [partner({ id: "1", name: "Taxi B", category: "transport" })];
    const ranked = rankPartnerCandidates(partners, { category: "restaurant", limit: DEFAULT_PARTNER_LIMIT });
    expect(ranked.map((p) => p.id)).toEqual(["1"]);
  });

  it("[no matching partner at all -> empty] zero active partners produces zero candidates, never a fabricated one", () => {
    const partners = [partner({ id: "1", name: "Inactif", category: "restaurant", is_active: false })];
    const ranked = rankPartnerCandidates(partners, { category: null, limit: DEFAULT_PARTNER_LIMIT });
    expect(ranked).toHaveLength(0);
  });
});

describe("buildPartnerAction", () => {
  it("[booking_url present] booking_url wins over website_url", () => {
    const action = buildPartnerAction({ booking_url: "https://book.example.com", website_url: "https://site.example.com" });
    expect(action).toEqual({ type: "partner_booking", label: "Réserver", url: "https://book.example.com" });
  });

  it("[only website_url] website_url is used when booking_url is absent", () => {
    const action = buildPartnerAction({ booking_url: null, website_url: "https://site.example.com" });
    expect(action).toEqual({ type: "partner_website", label: "Voir le site", url: "https://site.example.com" });
  });

  it("[neither] no fabricated link — null", () => {
    expect(buildPartnerAction({ booking_url: null, website_url: null })).toBeNull();
  });

  it("[never fabricated] the URL is always the exact database value, never derived or guessed", () => {
    const url = "https://exact-value.example.com/path?x=1";
    const action = buildPartnerAction({ booking_url: url, website_url: null });
    expect(action?.url).toBe(url);
  });
});

describe("toPartnerRecommendation", () => {
  it("[multilingual-safe] name/description are carried through verbatim — no translation performed here, that's the model's job downstream, facts are never altered by this function", () => {
    const p = partner({ id: "1", name: "Le Bistrot", category: "restaurant", description: "Cuisine traditionnelle française." });
    const rec = toPartnerRecommendation(p);
    expect(rec.name).toBe("Le Bistrot");
    expect(rec.description).toBe("Cuisine traditionnelle française.");
  });

  it("[opening_hours carried through] read straight from the row, verbatim, never computed", () => {
    const p = partner({ id: "1", name: "Le Bistrot", category: "restaurant", opening_hours: "Lun-Sam 12h-14h, 19h-22h" });
    const rec = toPartnerRecommendation(p);
    expect(rec.openingHours).toBe("Lun-Sam 12h-14h, 19h-22h");
  });

  it("[opening_hours absent] null, never fabricated", () => {
    const p = partner({ id: "1", name: "Le Bistrot", category: "restaurant" });
    const rec = toPartnerRecommendation(p);
    expect(rec.openingHours).toBeNull();
  });

  it("[action attached] the CTA is computed via buildPartnerAction, not reimplemented", () => {
    const p = partner({ id: "1", name: "X", category: "other", booking_url: "https://x.example.com" });
    const rec = toPartnerRecommendation(p);
    expect(rec.action).toEqual({ type: "partner_booking", label: "Réserver", url: "https://x.example.com" });
  });
});
