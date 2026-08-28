import { describe, expect, it } from "vitest";
import {
  buildAccommodationGroups,
  buildAccommodationTypesPayload,
  normalizeImageUrl,
  type AccommodationPageClassification,
  type AccommodationSourcePage,
} from "./accommodationGrouping";

const isImportable = (status: string) => status === "relevant" || status === "probably_technical";

// Real classifyAccommodationPage (features/crawler/accommodationPage.ts) is
// exercised in its own test file — here a minimal stand-in keeps this
// module's tests decoupled from that keyword list, and lets tests express
// intent directly via the page's own url ("/detail/..." vs "/listing/...")
// without depending on exact wording.
function classifyAccommodationPage(page: { url: string; title: string }): AccommodationPageClassification {
  if (page.url.includes("/detail/")) return "detail";
  if (page.url.includes("/listing/")) return "listing";
  return "not_accommodation";
}

function makePage(overrides: Partial<AccommodationSourcePage> & { finalUrl: string }): AccommodationSourcePage {
  return {
    canonicalUrl: null,
    title: "",
    headings: [],
    status: "relevant",
    images: [],
    guessedCapacity: null,
    ...overrides,
  };
}

function image(url: string, overrides: Partial<{ alt: string | null; nearbyHeading: string | null }> = {}) {
  return { url, alt: null, nearbyHeading: null, ...overrides };
}

describe("buildAccommodationGroups", () => {
  it("[not_accommodation excluded] a page classified not_accommodation produces no group, even with images", () => {
    const pages = [makePage({ finalUrl: "https://h.example/spa", title: "Spa", images: [image("https://h.example/spa1.jpg")] })];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups).toHaveLength(0);
  });

  it("[listing excluded from accommodation groups] a category/pricing page produces no group, even with images — it stays importable for RAG separately, which this module has no say over", () => {
    const pages = [
      makePage({ finalUrl: "https://h.example/listing/tarifs", title: "Nos Tarifs", images: [image("https://h.example/t1.jpg")] }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups).toHaveLength(0);
  });

  it("[non-importable status excluded] a duplicate/unreachable page produces no group even if it's a detail page", () => {
    const pages = [
      makePage({ finalUrl: "https://h.example/detail/chambre", status: "duplicate", images: [image("https://h.example/r1.jpg")] }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups).toHaveLength(0);
  });

  it("[detail page with images] a real room detail page produces exactly one group", () => {
    const pages = [
      makePage({
        finalUrl: "https://h.example/detail/le-studio",
        title: "Le Studio",
        images: [image("https://h.example/a.jpg"), image("https://h.example/b.jpg")],
      }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups).toHaveLength(1);
    expect(groups[0].sourceUrl).toBe("https://h.example/detail/le-studio");
    expect(groups[0].photos).toHaveLength(2);
  });

  it("[global dedup by image URL] the same image.url on two different detail pages appears only once total", () => {
    const shared = image("https://h.example/shared-hero.jpg");
    const pages = [
      makePage({ finalUrl: "https://h.example/detail/room-a", title: "Room A", images: [shared, image("https://h.example/a-only.jpg")] }),
      makePage({ finalUrl: "https://h.example/detail/room-b", title: "Room B", images: [shared, image("https://h.example/b-only.jpg")] }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    const allUrls = groups.flatMap((g) => g.photos.map((p) => p.url));
    expect(allUrls.filter((u) => u === "https://h.example/shared-hero.jpg")).toHaveLength(1);
    expect(allUrls).toHaveLength(3); // shared once + a-only + b-only
  });

  it("[distinct photos on the same page all kept] two different images on one detail page are never collapsed into one", () => {
    const pages = [
      makePage({
        finalUrl: "https://h.example/detail/room-a",
        title: "Room A",
        images: [image("https://h.example/1.jpg"), image("https://h.example/2.jpg"), image("https://h.example/3.jpg")],
      }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups[0].photos.map((p) => p.url)).toEqual([
      "https://h.example/1.jpg",
      "https://h.example/2.jpg",
      "https://h.example/3.jpg",
    ]);
  });

  it("[no cap — every distinct detected photo is kept] a page with 10 distinct images produces a group with all 10, none hidden", () => {
    const images = Array.from({ length: 10 }, (_, i) => image(`https://h.example/room-${i}.jpg`));
    const pages = [makePage({ finalUrl: "https://h.example/detail/le-crib", title: "Le Crib", images })];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups[0].photos).toHaveLength(10);
  });

  it("[no cap, even well beyond typical counts] 15 distinct images all remain available, uncapped", () => {
    const images = Array.from({ length: 15 }, (_, i) => image(`https://h.example/room-${i}.jpg`));
    const pages = [makePage({ finalUrl: "https://h.example/detail/le-crib", title: "Le Crib", images })];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups[0].photos).toHaveLength(15);
  });

  it("[exact duplicate collapses to a single photo] the same image URL repeated on a page still yields exactly one distinct photo", () => {
    const pages = [
      makePage({
        finalUrl: "https://h.example/detail/le-crib",
        title: "Le Crib",
        images: [image("https://h.example/hero.jpg"), image("https://h.example/hero.jpg"), image("https://h.example/other.jpg")],
      }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups[0].photos).toHaveLength(2);
  });

  it("[multiple detail pages => multiple groups] several detail pages each produce their own group, listing/not_accommodation pages contribute none", () => {
    const pages = [
      makePage({ finalUrl: "https://h.example/detail/le-studio", title: "Le Studio", images: [image("https://h.example/s1.jpg")] }),
      makePage({ finalUrl: "https://h.example/detail/le-snug", title: "Le Snug", images: [image("https://h.example/n1.jpg")] }),
      makePage({ finalUrl: "https://h.example/detail/le-crib", title: "Le Crib", images: [image("https://h.example/c1.jpg")] }),
      makePage({ finalUrl: "https://h.example/listing/tarifs", title: "Nos Tarifs", images: [image("https://h.example/t1.jpg")] }),
      makePage({ finalUrl: "https://h.example/spa", title: "Spa", images: [image("https://h.example/spa1.jpg")] }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups.map((g) => g.sourceUrl)).toEqual([
      "https://h.example/detail/le-studio",
      "https://h.example/detail/le-snug",
      "https://h.example/detail/le-crib",
    ]);
  });

  describe("canonical merge — same accommodation, two URLs", () => {
    it("[same normalized name => one group] two detail pages sharing the exact same suggested name are merged into one group", () => {
      const pages = [
        makePage({
          finalUrl: "https://h.example/detail/le-crib",
          title: "“Le Crib” – Chambre de luxe",
          images: [image("https://h.example/c1.jpg")],
        }),
        makePage({
          finalUrl: "https://h.example/detail/room/le-crib",
          title: "“Le Crib” – Chambre de luxe",
          images: [image("https://h.example/c2.jpg")],
        }),
      ];
      const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
      expect(groups).toHaveLength(1);
      expect(groups[0].mergedSourceUrls).toEqual(["https://h.example/detail/le-crib", "https://h.example/detail/room/le-crib"]);
    });

    it("[merged photos are combined then deduplicated] the two pages' photo pools are unioned, with any shared image counted once", () => {
      const shared = image("https://h.example/shared.jpg");
      const pages = [
        makePage({ finalUrl: "https://h.example/detail/le-crib", title: "Le Crib", images: [shared, image("https://h.example/c1.jpg")] }),
        makePage({
          finalUrl: "https://h.example/detail/room/le-crib",
          title: "Le Crib",
          images: [shared, image("https://h.example/c2.jpg")],
        }),
      ];
      const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
      expect(groups).toHaveLength(1);
      expect(groups[0].photos.map((p) => p.url).sort()).toEqual(
        ["https://h.example/shared.jpg", "https://h.example/c1.jpg", "https://h.example/c2.jpg"].sort()
      );
    });

    it("[different names => two groups] two detail pages with genuinely different names are never merged just because both mention a shared word", () => {
      const pages = [
        makePage({ finalUrl: "https://h.example/detail/deluxe", title: "Suite Deluxe", images: [image("https://h.example/d1.jpg")] }),
        makePage({ finalUrl: "https://h.example/detail/familiale", title: "Suite Familiale", images: [image("https://h.example/f1.jpg")] }),
      ];
      const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
      expect(groups).toHaveLength(2);
    });

    it("[canonicalUrl takes priority] two pages with different names but the SAME non-self canonicalUrl are still merged", () => {
      const pages = [
        makePage({
          finalUrl: "https://h.example/detail/le-crib-fr",
          canonicalUrl: "https://h.example/detail/le-crib-canonical",
          title: "Le Crib (FR)",
          images: [image("https://h.example/c1.jpg")],
        }),
        makePage({
          finalUrl: "https://h.example/detail/le-crib-en",
          canonicalUrl: "https://h.example/detail/le-crib-canonical",
          title: "The Crib (EN)",
          images: [image("https://h.example/c2.jpg")],
        }),
      ];
      const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
      expect(groups).toHaveLength(1);
      expect(groups[0].mergedSourceUrls).toHaveLength(2);
    });

    it("[self-referential canonicalUrl ignored] a page whose canonicalUrl equals its own finalUrl carries no merge information — falls back to name", () => {
      const pages = [
        makePage({
          finalUrl: "https://h.example/detail/le-crib",
          canonicalUrl: "https://h.example/detail/le-crib", // self-referential, like every page on chabanettes.com
          title: "Le Crib",
          images: [image("https://h.example/c1.jpg")],
        }),
        makePage({
          finalUrl: "https://h.example/detail/room/le-crib",
          canonicalUrl: "https://h.example/detail/room/le-crib", // also self-referential — different value, would NOT merge on canonicalUrl alone
          title: "Le Crib",
          images: [image("https://h.example/c2.jpg")],
        }),
      ];
      const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
      expect(groups).toHaveLength(1); // merged via name, not canonicalUrl
    });

    it("[merged group keeps the first page's suggested name] the first-encountered page's name wins, not the last", () => {
      const pages = [
        makePage({ finalUrl: "https://h.example/detail/a", title: "Le Crib", images: [image("https://h.example/1.jpg")] }),
        makePage({ finalUrl: "https://h.example/detail/b", title: "Le Crib", images: [image("https://h.example/2.jpg")] }),
      ];
      const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
      expect(groups[0].sourceUrl).toBe("https://h.example/detail/a");
    });
  });

  it("[suggested name from title] the page title (cleaned of a trailing dash) becomes the suggested name", () => {
    const pages = [
      makePage({
        finalUrl: "https://h.example/detail/le-crib",
        title: "“Le Crib” – Chambre Appart-hôtel de luxe -",
        images: [image("https://h.example/c1.jpg")],
      }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups[0].suggestedName).toBe("“Le Crib” – Chambre Appart-hôtel de luxe");
  });

  it("[suggested name falls back to heading] an empty title falls back to the first non-empty heading", () => {
    const pages = [
      makePage({
        finalUrl: "https://h.example/detail/le-crib",
        title: "",
        headings: ["", "Le Crib — chambre de luxe"],
        images: [image("https://h.example/c1.jpg")],
      }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups[0].suggestedName).toBe("Le Crib — chambre de luxe");
  });

  it("[suggested name falls back to nearbyHeading] no title, no heading, falls back to a photo's own nearbyHeading", () => {
    const pages = [
      makePage({
        finalUrl: "https://h.example/detail/le-crib",
        title: "",
        headings: [],
        images: [image("https://h.example/c1.jpg", { nearbyHeading: "Le Crib" })],
      }),
    ];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups[0].suggestedName).toBe("Le Crib");
  });

  it("[a detail page with zero images produces no group] classification is detail but no images at all -> nothing to show", () => {
    const pages = [makePage({ finalUrl: "https://h.example/detail/le-crib", title: "Le Crib", images: [] })];
    const groups = buildAccommodationGroups(pages, { isImportable, classifyAccommodationPage });
    expect(groups).toHaveLength(0);
  });
});

describe("normalizeImageUrl", () => {
  it("trims incidental whitespace", () => {
    expect(normalizeImageUrl("  https://h.example/a.jpg  ")).toBe("https://h.example/a.jpg");
  });
});

describe("buildAccommodationTypesPayload", () => {
  const groups = buildAccommodationGroups(
    [
      makePage({
        finalUrl: "https://h.example/detail/le-studio",
        title: "Le Studio",
        guessedCapacity: { value: 2 },
        images: [image("https://h.example/s1.jpg"), image("https://h.example/s2.jpg")],
      }),
      makePage({
        finalUrl: "https://h.example/detail/le-snug",
        title: "Le Snug",
        images: [image("https://h.example/n1.jpg")],
      }),
    ],
    { isImportable, classifyAccommodationPage }
  );

  it("[one accommodation per included group, never per photo] an included group with both photos checked yields exactly one payload entry, all photos carried, all selected", () => {
    const studioPhotoKeys = groups[0].photos.map((p) => p.key);
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key]),
      checkedPhotoKeys: new Set(studioPhotoKeys),
      names: {},
      capacities: {},
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].photos).toHaveLength(2);
    expect(payload[0].photos.every((p) => p.isSelected)).toBe(true);
    expect(payload[0].name).toBe("Le Studio");
  });

  it("[not included produces nothing] a group absent from includedGroupKeys contributes no payload entry, even with checked photos", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set(),
      checkedPhotoKeys: new Set(groups[0].photos.map((p) => p.key)),
      names: {},
      capacities: {},
    });
    expect(payload).toHaveLength(0);
  });

  it("[accommodation_type saveable with 0 selected photos] an included group with zero checked photos still produces a payload entry, every photo carried with isSelected: false", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key]),
      checkedPhotoKeys: new Set(),
      names: {},
      capacities: {},
    });
    expect(payload).toHaveLength(1);
    expect(payload[0].photos).toHaveLength(2);
    expect(payload[0].photos.every((p) => !p.isSelected)).toBe(true);
  });

  it("[multiple included groups => multiple entries, still one each] including both groups yields two entries, not more", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key, groups[1].key]),
      checkedPhotoKeys: new Set([groups[0].photos[0].key, groups[1].photos[0].key]),
      names: {},
      capacities: {},
    });
    expect(payload).toHaveLength(2);
    expect(payload.map((p) => p.name)).toEqual(["Le Studio", "Le Snug"]);
  });

  it("[edited name overrides suggestion] a name typed in the group's field is used instead of the suggested one", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key]),
      checkedPhotoKeys: new Set([groups[0].photos[0].key]),
      names: { [groups[0].key]: "Junior Suite" },
      capacities: {},
    });
    expect(payload[0].name).toBe("Junior Suite");
  });

  it("[blank edited name excludes the group] a name cleared to an empty/whitespace string drops that group from the payload, even when included", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key]),
      checkedPhotoKeys: new Set([groups[0].photos[0].key]),
      names: { [groups[0].key]: "   " },
      capacities: {},
    });
    expect(payload).toHaveLength(0);
  });

  it("[capacity never forced] an empty capacity input becomes maxGuests: null, never auto-filled from guessedCapacity behind the admin's back", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key]),
      checkedPhotoKeys: new Set([groups[0].photos[0].key]),
      names: {},
      capacities: {},
    });
    expect(payload[0].maxGuests).toBeNull();
  });

  it("[capacity respected when confirmed] a numeric capacity string is parsed into maxGuests", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key]),
      checkedPhotoKeys: new Set([groups[0].photos[0].key]),
      names: {},
      capacities: { [groups[0].key]: "2" },
    });
    expect(payload[0].maxGuests).toBe(2);
  });

  it("[invalid capacity string -> null] a non-numeric or zero/negative capacity is never sent as-is", () => {
    const payload = buildAccommodationTypesPayload(groups, {
      includedGroupKeys: new Set([groups[0].key]),
      checkedPhotoKeys: new Set([groups[0].photos[0].key]),
      names: {},
      capacities: { [groups[0].key]: "abc" },
    });
    expect(payload[0].maxGuests).toBeNull();
  });
});
