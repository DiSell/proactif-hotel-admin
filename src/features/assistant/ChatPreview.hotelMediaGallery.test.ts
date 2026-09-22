import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "ChatPreview.tsx"), "utf8");

/**
 * HOTEL_MEDIA CHATBOT chantier — Cas H (ChatPreview sait rendre
 * hotelMediaGallery) + Cas I (aucun bouton Réserver/lien chambre dans cette
 * galerie). Same DOM-less, source-level discipline as every other
 * ChatPreview test file in this repo (no jsdom).
 */
describe("ChatPreview — hotelMediaGallery (Cas H)", () => {
  it("[type carried through ChatMessage and ChatApiResponse]", () => {
    expect(source).toMatch(/hotelMediaGallery\?: HotelMediaGallery \| null;/);
    expect(source).toMatch(/hotelMediaGallery: HotelMediaGallery \| null;/);
  });

  it("[read from the fetch response into the assistant message]", () => {
    expect(source).toMatch(/hotelMediaGallery: data\.hotelMediaGallery,/);
  });

  it("[own state, independent of openRoomRecommendation]", () => {
    expect(source).toMatch(/const \[openHotelMediaGallery, setOpenHotelMediaGallery\] = useState<HotelMediaGallery \| null>\(null\);/);
  });

  it("[button only renders when hotelMediaGallery is present, opens the dedicated state]", () => {
    expect(source).toMatch(/message\.role === "assistant" && message\.hotelMediaGallery && \(/);
    expect(source).toMatch(/onClick=\{\(\) => setOpenHotelMediaGallery\(message\.hotelMediaGallery \?\? null\)\}/);
  });
});

/**
 * CORRECTION CIBLÉE chantier — miniatures directement sous le message,
 * cliquables, ouvrant EXACTEMENT le même RoomPhotoModal que le bouton
 * existant (jamais un second modal, jamais de duplication de données : la
 * même message.hotelMediaGallery.photos alimente les deux).
 */
describe("ChatPreview — miniatures hotel_media (Cas A, B, D, I)", () => {
  it("[Cas A — une miniature par photo] map sur message.hotelMediaGallery.photos, jamais une liste séparée ou recalculée", () => {
    expect(source).toMatch(/message\.hotelMediaGallery\.photos\.map\(\(photo, index\) => \(/);
  });

  it("[gated by photos.length > 0] jamais de rangée de miniatures vide", () => {
    expect(source).toMatch(/message\.hotelMediaGallery && message\.hotelMediaGallery\.photos\.length > 0 && \(/);
  });

  it("[Cas B — clic sur une miniature ouvre le même RoomPhotoModal] même setOpenHotelMediaGallery que le bouton, jamais un state séparé", () => {
    const thumbStart = source.indexOf("message.hotelMediaGallery.photos.map((photo, index) => (");
    const thumbBlock = source.slice(thumbStart, thumbStart + 700);
    expect(thumbBlock).toMatch(/onClick=\{\(\) => setOpenHotelMediaGallery\(message\.hotelMediaGallery \?\? null\)\}/);
  });

  it("[object-fit: cover, alt depuis photo.alt sinon le libellé de catégorie]", () => {
    const thumbStart = source.indexOf("message.hotelMediaGallery.photos.map((photo, index) => (");
    const thumbBlock = source.slice(thumbStart, thumbStart + 1100);
    expect(thumbBlock).toMatch(/object-cover/);
    expect(thumbBlock).toMatch(/alt=\{photo\.alt \?\? message\.hotelMediaGallery\?\.label \?\? ""\}/);
  });

  it("[Cas D — le bouton \"Voir les photos\" existant reste présent et fonctionnel en plus des miniatures]", () => {
    expect(source).toMatch(/Voir les photos — \{message\.hotelMediaGallery\.label\}/);
  });

  it("[aucune duplication de données] miniatures et bouton lisent tous les deux message.hotelMediaGallery.photos / .label — jamais un second champ ou une seconde requête", () => {
    const occurrences = source.match(/message\.hotelMediaGallery\.photos/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // au moins: le .map() lui-même + le gate .length > 0
  });
});

describe("ChatPreview — hotelMediaGallery gallery never carries a room/booking affordance (Cas I)", () => {
  it("[RoomPhotoModal reused as-is, pageUrl/bookingUrl always null] no onBooking, no accommodation page link, no Réserver button possible for this modal instance", () => {
    const start = source.indexOf("{openHotelMediaGallery && (");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf(")}", start) + 2);
    expect(block).toMatch(/pageUrl=\{null\}/);
    expect(block).toMatch(/bookingUrl=\{null\}/);
    expect(block).not.toMatch(/onBooking/);
  });

  it("[never the same RoomPhotoModal instance as roomRecommendation] two independent <RoomPhotoModal conditionally rendered, never merged into one", () => {
    const occurrences = source.match(/<RoomPhotoModal/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});
