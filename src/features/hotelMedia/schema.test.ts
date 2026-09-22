import { describe, expect, it } from "vitest";
import { HOTEL_MEDIA_CATEGORIES } from "@/types/database";
import { addHotelMediaSchema, HOTEL_MEDIA_CATEGORY_LABEL, hotelMediaCategorySchema } from "./schema";

const validInput = {
  category: "pool" as const,
  title: "Bassin principal",
  altText: "Piscine intérieure chauffée",
  storagePath: "hotel-a/abc.jpg",
  photoUrl: "https://storage.example.com/hotel-media/hotel-a/abc.jpg",
  contentHash: "a".repeat(64),
};

describe("hotelMediaCategorySchema — génériques, jamais spécifiques au 1837", () => {
  it.each(HOTEL_MEDIA_CATEGORIES)("accepts %s", (category) => {
    expect(hotelMediaCategorySchema.safeParse(category).success).toBe(true);
  });

  it("rejects an unknown category", () => {
    expect(hotelMediaCategorySchema.safeParse("wine_cellar").success).toBe(false);
  });

  it("[libellés FR] every category has a French label, no category is missing", () => {
    for (const category of HOTEL_MEDIA_CATEGORIES) {
      expect(HOTEL_MEDIA_CATEGORY_LABEL[category]).toBeTruthy();
    }
  });
});

describe("addHotelMediaSchema", () => {
  it("[entrée valide complète] accepted as-is", () => {
    const result = addHotelMediaSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("[titre/alt facultatifs] chaîne vide devient null, jamais stockée telle quelle", () => {
    const result = addHotelMediaSchema.safeParse({ ...validInput, title: "", altText: "" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBeNull();
      expect(result.data.altText).toBeNull();
    }
  });

  it("[catégorie invalide -> refus]", () => {
    expect(addHotelMediaSchema.safeParse({ ...validInput, category: "not_a_category" }).success).toBe(false);
  });

  it.each(["", "not-a-hash", "a".repeat(63), "a".repeat(65), "g".repeat(64)])("[empreinte invalide -> refus] %s", (contentHash) => {
    expect(addHotelMediaSchema.safeParse({ ...validInput, contentHash }).success).toBe(false);
  });

  it("[empreinte en majuscules acceptée] hex is case-insensitive", () => {
    expect(addHotelMediaSchema.safeParse({ ...validInput, contentHash: "A".repeat(64) }).success).toBe(true);
  });

  it("[photoUrl doit être une URL valide]", () => {
    expect(addHotelMediaSchema.safeParse({ ...validInput, photoUrl: "not-a-url" }).success).toBe(false);
  });

  it("[storagePath requis, non vide]", () => {
    expect(addHotelMediaSchema.safeParse({ ...validInput, storagePath: "" }).success).toBe(false);
  });

  it("[aucun champ hotelId dans ce schéma] — hotelId n'est jamais fourni par le client, uniquement par la page/l'action", () => {
    expect(Object.keys(validInput)).not.toContain("hotelId");
    const result = addHotelMediaSchema.safeParse({ ...validInput, hotelId: "attacker-hotel" });
    // .strict() n'est pas utilisé ici, mais hotelId n'a de toute façon aucune influence : vérifions qu'il n'apparaît pas dans les données validées.
    expect(result.success && "hotelId" in result.data).toBe(false);
  });
});
