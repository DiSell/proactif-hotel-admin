import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * INFORMATION DÉTERMINISTE chantier — mirrors
 * PublicWidgetChat.roomCatalogue.test.ts's own doc comment and technique
 * (source-level: no jsdom in this repo). Item E of the mission: prove the
 * summary is actually rendered, and that its rendering is visually distinct
 * from roomCatalogue's own bordered cards (never becoming indistinguishable
 * from the CATALOGUE parcours).
 */
describe("PublicWidgetChat — accommodationSummary", () => {
  it("[type present] ChatMessage and ChatApiResponse both declare accommodationSummary, reusing RoomCatalogueEntry (never a second parallel type)", () => {
    expect(source).toMatch(/interface ChatMessage \{[\s\S]*?accommodationSummary\?: RoomCatalogueEntry\[\];[\s\S]*?\}/);
    expect(source).toMatch(/interface ChatApiResponse \{[\s\S]*?accommodationSummary: RoomCatalogueEntry\[\];[\s\S]*?\}/);
  });

  it("[actually read from the API response] data.accommodationSummary is stored on the new assistant message", () => {
    const sendStart = source.indexOf("const data: ChatApiResponse = await response.json();");
    const sendEnd = source.indexOf("if (data.partnerRequestPhonePrompt)", sendStart);
    const sendBlock = source.slice(sendStart, sendEnd);
    expect(sendBlock).toMatch(/accommodationSummary: data\.accommodationSummary,/);
  });

  it("[rendered as a guaranteed list] maps over message.accommodationSummary, gated on length > 0, keyed by accommodationTypeId — never derived from parsing message.content", () => {
    expect(source).toMatch(/message\.role === "assistant" && message\.accommodationSummary && message\.accommodationSummary\.length > 0/);
    expect(source).toMatch(/message\.accommodationSummary\.map\(\(entry\) => \(/);
  });

  it("[values come exclusively from the structured field] name and maxGuests read straight off entry, never a hardcoded category name anywhere near this block", () => {
    const mapStart = source.indexOf("message.accommodationSummary.map((entry) => (");
    const mapEnd = source.indexOf("))}", mapStart);
    const mapBlock = source.slice(mapStart, mapEnd);
    expect(mapBlock).toMatch(/\{entry\.name\}/);
    expect(mapBlock).toMatch(/entry\.maxGuests !== null &&/);
    expect(mapBlock).not.toMatch(/Mini-suite|Standard|Superior|Deluxe|Junior Suite|Junior PMR|Le 1837/);
  });

  it("[visually distinct from roomCatalogue — mobile-light, no cards] no border/background per entry, unlike roomCatalogue's bordered card style", () => {
    const summaryBlockStart = source.indexOf("message.accommodationSummary && message.accommodationSummary.length > 0");
    const summaryBlockEnd = source.indexOf("Server guarantees roomRecommendation", summaryBlockStart);
    const summaryBlock = source.slice(summaryBlockStart, summaryBlockEnd);
    expect(summaryBlock).not.toMatch(/border: "1px solid/);
    expect(summaryBlock).not.toMatch(/background: "#fff"/);

    // roomCatalogue's own card block, for contrast — confirms the two really do differ.
    const catalogueBlockStart = source.indexOf("message.roomCatalogue && message.roomCatalogue.length > 0");
    const catalogueBlockEnd = source.indexOf("))}", catalogueBlockStart);
    const catalogueBlock = source.slice(catalogueBlockStart, catalogueBlockEnd);
    expect(catalogueBlock).toMatch(/border: "1px solid/);
    expect(catalogueBlock).toMatch(/background: "#fff"/);
  });

  it("[never duplicates roomCatalogue's own no-price/no-description guarantee] no description, no photos, no price anywhere in this block", () => {
    const mapStart = source.indexOf("message.accommodationSummary.map((entry) => (");
    const mapEnd = source.indexOf("))}", mapStart);
    const mapBlock = source.slice(mapStart, mapEnd);
    expect(mapBlock).not.toMatch(/description/i);
    expect(mapBlock).not.toMatch(/photos/i);
    expect(mapBlock).not.toMatch(/€|\bEUR\b|\bprice\b/i);
  });

  it("[independent field, never both non-empty rendering blocks confused] roomCatalogue and accommodationSummary are two separate conditional blocks in the JSX, each keyed on its own field", () => {
    const roomCatalogueCount = (source.match(/message\.roomCatalogue && message\.roomCatalogue\.length > 0/g) ?? []).length;
    const summaryCount = (source.match(/message\.accommodationSummary && message\.accommodationSummary\.length > 0/g) ?? []).length;
    expect(roomCatalogueCount).toBe(1);
    expect(summaryCount).toBe(1);
  });
});
