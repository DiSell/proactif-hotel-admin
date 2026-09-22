import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { detectHotelMediaCategory, isHotelMediaPhotoRequest, loadSelectedHotelMediaPhotos } from "./hotelMediaGallery";

/**
 * HOTEL_MEDIA CHATBOT chantier — mirrors features/rag/roomPhotos.test.ts's
 * own fakeSupabase exactly (same shape, same real-invocation discipline)
 * for the loader, plus real invocation of the two pure detectors — no
 * mocking infra needed for either, same as
 * accommodationRanking.ts/partners.ts's own detector tests.
 */
function fakeSupabase(
  calls: { table?: string; columns?: string; eqs?: [string, unknown][]; order?: [string, unknown] },
  result: { data: unknown; error: unknown }
): SupabaseClient {
  return {
    from(table: string) {
      calls.table = table;
      return {
        select(columns: string) {
          calls.columns = columns;
          calls.eqs = [];
          const node = {
            eq(column: string, value: unknown) {
              calls.eqs!.push([column, value]);
              return node;
            },
            order: async (column: string, options: unknown) => {
              calls.order = [column, options];
              return result;
            },
          };
          return node;
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("loadSelectedHotelMediaPhotos", () => {
  it("[exact table/columns/filters/order — this IS Cas C, la garantie is_selected] hotel_id, category, is_selected=true, ORDER BY position ascending — nothing more, nothing less; a photo with is_selected=false is filtered at the query level, never returned regardless of what the table actually contains", async () => {
    const calls: { table?: string; columns?: string; eqs?: [string, unknown][]; order?: [string, unknown] } = {};
    const supabase = fakeSupabase(calls, { data: [], error: null });
    await loadSelectedHotelMediaPhotos(supabase, "hotel-1", "pool");

    expect(calls.table).toBe("hotel_media");
    expect(calls.columns).toBe("photo_url, alt_text");
    expect(calls.eqs).toEqual([
      ["hotel_id", "hotel-1"],
      ["category", "pool"],
      ["is_selected", true],
    ]);
    expect(calls.order).toEqual(["position", { ascending: true }]);
  });

  it("[Cas D — maps photo_url/alt_text -> url/alt, preserving the returned (position-ordered) order]", async () => {
    const supabase = fakeSupabase({}, {
      data: [
        { photo_url: "https://cdn.example.com/pos0.jpg", alt_text: "Première" },
        { photo_url: "https://cdn.example.com/pos1.jpg", alt_text: null },
      ],
      error: null,
    });
    const photos = await loadSelectedHotelMediaPhotos(supabase, "hotel-1", "pool");
    expect(photos).toEqual([
      { url: "https://cdn.example.com/pos0.jpg", alt: "Première" },
      { url: "https://cdn.example.com/pos1.jpg", alt: null },
    ]);
  });

  it("[null data] resolves to an empty array, never throws/null", async () => {
    const supabase = fakeSupabase({}, { data: null, error: null });
    const photos = await loadSelectedHotelMediaPhotos(supabase, "hotel-1", "sauna");
    expect(photos).toEqual([]);
  });
});

describe("detectHotelMediaCategory — synonymes FR", () => {
  it.each([
    ["Montrez-moi la piscine", "pool"],
    ["Je peux voir le spa ?", "spa"],
    ["Vous avez des photos de la salle de sport ?", "fitness"],
    ["À quoi ressemble le petit-déjeuner ?", "breakfast"],
    ["Je voudrais voir le restaurant", "restaurant"],
    ["Montrez-moi les salles de séminaire", "seminar"],
    ["On organise notre mariage, montrez-moi la salle", "wedding"],
    ["Montrez-moi le sauna", "sauna"],
    ["Montrez-moi le hammam", "hammam"],
    ["Montrez-moi le jacuzzi", "jacuzzi"],
    ["Montrez-moi la chapelle", "chapel"],
    ["Montrez-moi le parking", "parking"],
  ] as const)("%s -> %s", (message, expected) => {
    expect(detectHotelMediaCategory(message)).toBe(expected);
  });

  it("[aucune catégorie -> null]", () => {
    expect(detectHotelMediaCategory("Quel temps fait-il aujourd'hui ?")).toBeNull();
  });

  it("[jamais 'other'] aucun synonyme ne cible la catégorie fourre-tout", () => {
    expect(detectHotelMediaCategory("autre chose")).toBeNull();
  });
});

describe("detectHotelMediaCategory — collisions (ATTENTION AUX COLLISIONS)", () => {
  it("[façade] 'façade' cible facade", () => {
    expect(detectHotelMediaCategory("Montrez-moi la façade")).toBe("facade");
  });

  it("['extérieur de l'hôtel' cible facade, jamais exterior]", () => {
    expect(detectHotelMediaCategory("Montrez-moi l'extérieur de l'hôtel")).toBe("facade");
  });

  it("['devant de l'hôtel' cible facade]", () => {
    expect(detectHotelMediaCategory("Montrez-moi le devant de l'hôtel")).toBe("facade");
  });

  it("['parc' cible exterior]", () => {
    expect(detectHotelMediaCategory("Montrez-moi le parc")).toBe("exterior");
  });

  it("['jardin' cible exterior]", () => {
    expect(detectHotelMediaCategory("Montrez-moi le jardin")).toBe("exterior");
  });

  it("['extérieur' seul (sans 'de l'hôtel') cible exterior]", () => {
    expect(detectHotelMediaCategory("Montrez-moi l'extérieur")).toBe("exterior");
  });

  it("['réception' seule (mariage) cible wedding]", () => {
    expect(detectHotelMediaCategory("Nous cherchons une salle de réception")).toBe("wedding");
  });

  it("['réception de l'hôtel' cible common_area, jamais wedding]", () => {
    expect(detectHotelMediaCategory("Montrez-moi la réception de l'hôtel")).toBe("common_area");
  });

  it("['réception de l'établissement' cible common_area]", () => {
    expect(detectHotelMediaCategory("Où se trouve la réception de l'établissement ?")).toBe("common_area");
  });

  it("['espaces communs' cible common_area]", () => {
    expect(detectHotelMediaCategory("Je voudrais voir les espaces communs")).toBe("common_area");
  });

  it("[Cas E — 'Montrez-moi la Deluxe' ne cible aucune catégorie hotel_media] le nom d'un hébergement ne correspond à aucun mot-clé", () => {
    expect(detectHotelMediaCategory("Montrez-moi la Deluxe")).toBeNull();
  });
});

describe("isHotelMediaPhotoRequest — intention visuelle vs question factuelle", () => {
  it.each([
    "Montrez-moi la piscine",
    "Je peux voir le spa ?",
    "Vous avez des photos de la salle de sport ?",
    "À quoi ressemble le petit-déjeuner ?",
    "Je voudrais voir le restaurant",
  ])("[demande visuelle reconnue] %s", (message) => {
    expect(isHotelMediaPhotoRequest(message)).toBe(true);
  });

  it("[Cas F — question factuelle 'Avez-vous une piscine ?' ne déclenche PAS une intention visuelle]", () => {
    expect(isHotelMediaPhotoRequest("Avez-vous une piscine ?")).toBe(false);
  });

  it("[question factuelle générique sur le sauna]", () => {
    expect(isHotelMediaPhotoRequest("Avez-vous un sauna ?")).toBe(false);
  });
});
