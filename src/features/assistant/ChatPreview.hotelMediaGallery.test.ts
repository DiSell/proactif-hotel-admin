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
