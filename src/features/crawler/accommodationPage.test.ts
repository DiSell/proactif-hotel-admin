import { describe, expect, it } from "vitest";
import { classifyAccommodationPage, isAccommodationPage } from "./accommodationPage";

function page(overrides: Partial<{ url: string; title: string }>) {
  return { url: "", title: "", ...overrides };
}

describe("isAccommodationPage", () => {
  it("[FR room page] a URL containing 'chambre' is included", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/chambre-double-luxe" }))).toBe(true);
  });

  it("[EN room page] a URL containing 'room' is included", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/deluxe-room-suite" }))).toBe(true);
  });

  it("[FR title only] a title mentioning 'Suite' with no keyword in the URL is still included", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/le-snug", title: "La Suite Snug – Chambre luxe" }))).toBe(true);
  });

  it("[headings not matched, deliberately] a page whose ONLY room-keyword signal would be in a heading is excluded — see isAccommodationPage's own doc comment: verified against a real crawl that this avoids a genuine false positive (a bio page matching via an unrelated heading), at the cost of not catching this narrower case", () => {
    // No such case exists to assert true on: this function's signature no
    // longer accepts headings at all — a page with a room keyword ONLY in
    // a heading (never in its url or title) is indistinguishable here from
    // one with no room signal whatsoever, by design.
    expect(isAccommodationPage(page({ url: "https://hotel.example/le-crib", title: "Le Crib" }))).toBe(false);
  });

  it("[spa page excluded] a page about the spa, with no room keyword anywhere, is excluded", () => {
    expect(
      isAccommodationPage(page({ url: "https://hotel.example/spa-bien-etre", title: "Spa & Massages bien-être" }))
    ).toBe(false);
  });

  it("[restaurant excluded] a page about the restaurant is excluded", () => {
    expect(
      isAccommodationPage(page({ url: "https://hotel.example/salle-a-manger-restaurant", title: "La Salle à Manger" }))
    ).toBe(false);
  });

  it("[blog excluded] a generic blog post, with no room keyword, is excluded", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/blog/nos-randonnees-preferees", title: "Blog" }))).toBe(false);
  });

  it("[author archive excluded] an author archive page is excluded", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/author/tbell", title: "Tim Bell" }))).toBe(false);
  });

  it("[legal notice excluded] a mentions légales page is excluded", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/mentions-legales", title: "Mentions Légales" }))).toBe(false);
  });

  it("[gallery excluded] a general photo gallery page, with no room keyword, is excluded", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/galerie-photos", title: "Galerie" }))).toBe(false);
  });

  it("[hotel/spa alone insufficient] the words 'hotel' and 'spa' alone, without any room keyword, never qualify a page", () => {
    expect(
      isAccommodationPage(
        page({ url: "https://boutique-hotel-spa.example/qui-sommes-nous", title: "Boutique Hotel & Spa — Qui sommes-nous" })
      )
    ).toBe(false);
  });

  it("[EN accommodation] the word 'accommodation' alone qualifies a page", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/our-accommodation" }))).toBe(true);
  });

  it("[FR hébergement, accented] the accented form is matched, not just the unaccented one", () => {
    expect(isAccommodationPage(page({ title: "Nos hébergements de charme" }))).toBe(true);
  });

  it("[studio] a URL containing 'studio' alone qualifies a page", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/le-studio-luxe" }))).toBe(true);
  });

  it("[plural via substring] 'chambres' (plural) matches through the singular 'chambre' keyword — no separate plural entry needed", () => {
    expect(isAccommodationPage(page({ url: "https://hotel.example/nos-chambres" }))).toBe(true);
  });

  it("[nothing matches] a page with no url/title signal at all is excluded", () => {
    expect(isAccommodationPage(page({}))).toBe(false);
  });
});

describe("classifyAccommodationPage", () => {
  it("[detail — single named room] a page for one specific, named room is DETAIL", () => {
    expect(classifyAccommodationPage(page({ url: "https://hotel.example/le-studio", title: "Le Studio" }))).toBe("detail");
  });

  it("[detail — EN example from spec] 'Suite Deluxe' is DETAIL", () => {
    expect(classifyAccommodationPage(page({ url: "https://hotel.example/suite-deluxe", title: "Suite Deluxe" }))).toBe("detail");
  });

  it("[detail — EN example from spec] 'Room — The Snug' is DETAIL", () => {
    expect(classifyAccommodationPage(page({ url: "https://hotel.example/the-snug", title: "Room — The Snug" }))).toBe("detail");
  });

  it("[listing — pricing page, spec example] 'Tarifs des chambres' is LISTING, not DETAIL", () => {
    expect(
      classifyAccommodationPage(page({ url: "https://hotel.example/tarifs-des-chambres", title: "Nos Tarifs 2026" }))
    ).toBe("listing");
  });

  it("[listing — generic plural, spec example] 'Nos chambres' is LISTING, not DETAIL", () => {
    expect(classifyAccommodationPage(page({ url: "https://hotel.example/nos-chambres", title: "Nos Chambres" }))).toBe("listing");
  });

  it("[listing — category page, spec example] 'Chambres doubles' is LISTING, not DETAIL", () => {
    expect(
      classifyAccommodationPage(page({ url: "https://hotel.example/chambres-doubles", title: "Les Chambres Doubles" }))
    ).toBe("listing");
  });

  it("[listing — EN plural] a URL/title using the plural 'rooms' is LISTING", () => {
    expect(classifyAccommodationPage(page({ url: "https://hotel.example/our-rooms", title: "Our Rooms" }))).toBe("listing");
  });

  it("[listing — EN pricing word] 'rate'/'pricing' alone (with a room keyword elsewhere) is LISTING", () => {
    expect(classifyAccommodationPage(page({ url: "https://hotel.example/room-rates", title: "Room Rates" }))).toBe("listing");
  });

  it("[not_accommodation — no room keyword at all] a spa page is excluded outright, never DETAIL or LISTING", () => {
    expect(classifyAccommodationPage(page({ url: "https://hotel.example/spa", title: "Spa & Wellness" }))).toBe("not_accommodation");
  });

  it("[not_accommodation — editorial override, real case] a 'business for sale' bio page mentioning 'hébergement' is NOT_ACCOMMODATION, never DETAIL — the exact false positive found auditing chabanettes.com", () => {
    expect(
      classifyAccommodationPage(
        page({
          url: "https://hotel.example/qui-sommes-nous/hotel-restaurant-bar-spa-hebergement-touristique-a-vendre",
          title: "Spa Hôtel/Boutique B&B et hébergement touristique à vendre",
        })
      )
    ).toBe("not_accommodation");
  });

  it("[not_accommodation — EN editorial override] an 'about us' page mentioning 'accommodation' is NOT_ACCOMMODATION", () => {
    expect(
      classifyAccommodationPage(page({ url: "https://hotel.example/about-us", title: "About Us — Our Accommodation Business" }))
    ).toBe("not_accommodation");
  });

  it("[a room keyword alone is not automatically DETAIL] a page containing 'chambre' is LISTING when it's plural/category-shaped — not every accommodation-keyword match is a detail page", () => {
    const result = classifyAccommodationPage(page({ url: "https://hotel.example/chambres", title: "Chambres" }));
    expect(result).not.toBe("detail");
    expect(result).toBe("listing");
  });
});
