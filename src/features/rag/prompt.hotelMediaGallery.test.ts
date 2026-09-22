import { describe, expect, it } from "vitest";
import { buildHotelInstructions } from "./prompt";
import type { ChatbotSettings, Hotel } from "@/types/database";

/**
 * HOTEL_MEDIA CHATBOT chantier — CORRECTION CIBLÉE (miniatures + contradiction
 * du texte). Real invocation, same convention as every other
 * buildHotelInstructions test in prompt.test.ts (pure function, no mocking).
 */
function makeHotel(overrides: Partial<Hotel> = {}): Hotel {
  return {
    id: "hotel-a",
    name: "Le 1837",
    slug: "le-1837",
    widget_key: "ps_live_test",
    website: "https://le1837.example.com",
    logo_url: null,
    address: null,
    postal_code: null,
    city: "Saint-Affrique",
    country: "France",
    phone: null,
    email: null,
    primary_color: "#1A1D1A",
    secondary_color: "#8A6A3E",
    languages: ["fr", "en"],
    default_language: "fr",
    booking_url: null,
    spa_booking_url: null,
    booking_action_mode: "url",
    host_booking_trigger: null,
    assistant_name: "Camille",
    assistant_enabled: true,
    photo_management: "client",
    total_accommodation_units: null,
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSettings(overrides: Partial<ChatbotSettings> = {}): ChatbotSettings {
  return {
    id: "settings-a",
    hotel_id: "hotel-a",
    welcome_message: "Bonjour !",
    fallback_message: "Je ne sais pas.",
    handoff_email: null,
    handoff_phone: null,
    tone: "warm",
    formality: "vous",
    response_length: "normal",
    commercial_proactivity: "discreet",
    custom_instructions: null,
    allow_price_communication: false,
    handover_sms_phone_primary: null,
    handover_sms_phone_secondary: null,
    handover_sms_phone_backup: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildHotelInstructions — hotelMediaGalleryRequest (Cas A — pas de contradiction textuelle)", () => {
  it("[photoCount > 0] instruit explicitement le modèle de ne jamais dire qu'aucune photo n'est disponible, et lui donne le nombre exact", () => {
    const instructions = buildHotelInstructions({
      hotel: makeHotel(),
      settings: makeSettings(),
      groundingMode: "grounded",
      hotelMediaGalleryRequest: { label: "Piscine", photoCount: 2 },
    });
    expect(instructions).toMatch(/joindra automatiquement à ta réponse 2 photo\(s\) vérifiée\(s\) de la catégorie "Piscine"/);
    expect(instructions).toMatch(/Ne dis JAMAIS que tu ne disposes d'aucune photo/);
  });

  it("[label vient du paramètre fourni par le serveur, jamais recalculé ici]", () => {
    const instructions = buildHotelInstructions({
      hotel: makeHotel(),
      settings: makeSettings(),
      groundingMode: "grounded",
      hotelMediaGalleryRequest: { label: "Spa", photoCount: 3 },
    });
    expect(instructions).toContain('catégorie "Spa"');
    expect(instructions).toContain("3 photo(s)");
  });
});

describe("buildHotelInstructions — hotelMediaGalleryRequest (Cas sans photo — ne jamais transformer en absence d'équipement)", () => {
  it("[photoCount === 0] dit honnêtement qu'aucune photo n'est disponible, mais interdit explicitement de conclure à l'absence de l'équipement", () => {
    const instructions = buildHotelInstructions({
      hotel: makeHotel(),
      settings: makeSettings(),
      groundingMode: "grounded",
      hotelMediaGalleryRequest: { label: "Sauna", photoCount: 0 },
    });
    expect(instructions).toMatch(/Aucune photo vérifiée n'est actuellement disponible pour la catégorie "Sauna"/);
    expect(instructions).toMatch(/ne transforme JAMAIS cette absence de photo en absence de l'équipement ou du service lui-même/);
  });
});

describe("buildHotelInstructions — hotelMediaGalleryRequest absent (Cas F — question factuelle, pas d'intention visuelle)", () => {
  it("[null] n'ajoute aucune instruction relative aux photos de l'établissement — comportement inchangé pour tout autre tour", () => {
    const instructions = buildHotelInstructions({
      hotel: makeHotel(),
      settings: makeSettings(),
      groundingMode: "grounded",
      hotelMediaGalleryRequest: null,
    });
    expect(instructions).not.toMatch(/PHOTOS DE L'ÉTABLISSEMENT/);
  });

  it("[omis] même comportement que null — jamais d'erreur, jamais de bloc ajouté par défaut", () => {
    const instructions = buildHotelInstructions({ hotel: makeHotel(), settings: makeSettings(), groundingMode: "grounded" });
    expect(instructions).not.toMatch(/PHOTOS DE L'ÉTABLISSEMENT/);
  });
});

describe("buildHotelInstructions — hotelMediaGalleryRequest orthogonal à groundingMode", () => {
  it("[no_context] fonctionne identiquement en mode no_context — indépendant du retrieval, comme les autres guidances déterministes", () => {
    const instructions = buildHotelInstructions({
      hotel: makeHotel(),
      settings: makeSettings(),
      groundingMode: "no_context",
      hotelMediaGalleryRequest: { label: "Piscine", photoCount: 2 },
    });
    expect(instructions).toMatch(/joindra automatiquement à ta réponse 2 photo\(s\) vérifiée\(s\) de la catégorie "Piscine"/);
  });
});
