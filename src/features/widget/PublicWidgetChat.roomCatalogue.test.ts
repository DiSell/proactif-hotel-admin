import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "PublicWidgetChat.tsx"), "utf8");

/**
 * Source-level audit for the roomCatalogue render — same constraint as
 * PublicWidgetChat.partnerRequestPhone.test.ts: "use client" component,
 * vitest's environment is "node" (no jsdom in this repo), so a real render
 * can't be exercised. Confirms the wiring a render test would otherwise
 * check: the field is actually read from the API response, stored on the
 * message, and rendered — this chantier's own diagnostic found that a
 * backend fix alone (the field existing in the API response) is NOT enough:
 * before this fix, PublicWidgetChat never read roomCatalogue at all, so a
 * visitor never actually saw the guaranteed 7 categories despite the server
 * computing them correctly.
 */
describe("PublicWidgetChat — roomCatalogue", () => {
  it("[type present] ChatMessage and ChatApiResponse both declare roomCatalogue", () => {
    expect(source).toMatch(/interface ChatMessage \{[\s\S]*?roomCatalogue\?: RoomCatalogueEntry\[\];[\s\S]*?\}/);
    expect(source).toMatch(/interface ChatApiResponse \{[\s\S]*?roomCatalogue: RoomCatalogueEntry\[\];[\s\S]*?\}/);
  });

  it("[no price field] RoomCatalogueEntry mirrors the server type exactly — accommodationTypeId/name/pageUrl/maxGuests only, structurally incapable of carrying a price", () => {
    const ifaceStart = source.indexOf("interface RoomCatalogueEntry");
    const ifaceEnd = source.indexOf("}", ifaceStart);
    const iface = source.slice(ifaceStart, ifaceEnd);
    expect(iface).toMatch(/accommodationTypeId: string;/);
    expect(iface).toMatch(/name: string;/);
    expect(iface).toMatch(/pageUrl: string \| null;/);
    expect(iface).toMatch(/maxGuests: number \| null;/);
    expect(iface).not.toMatch(/price/i);
  });

  it("[actually read from the API response] data.roomCatalogue is stored on the new assistant message — this is the exact gap the diagnostic found (the field existed in the response but was never read)", () => {
    const sendStart = source.indexOf("const data: ChatApiResponse = await response.json();");
    const sendEnd = source.indexOf("if (data.partnerRequestPhonePrompt)", sendStart);
    const sendBlock = source.slice(sendStart, sendEnd);
    expect(sendBlock).toMatch(/roomCatalogue: data\.roomCatalogue,/);
  });

  it("[rendered as a guaranteed list] maps over message.roomCatalogue, gated on length > 0, keyed by accommodationTypeId — never derived from parsing message.content", () => {
    expect(source).toMatch(/message\.role === "assistant" && message\.roomCatalogue && message\.roomCatalogue\.length > 0/);
    expect(source).toMatch(/message\.roomCatalogue\.map\(\(entry\) => \(/);
    expect(source).toMatch(/key=\{entry\.accommodationTypeId\}/);
  });

  it("[name always shown, capacity conditional]", () => {
    const mapStart = source.indexOf("message.roomCatalogue.map((entry) => (");
    const mapEnd = source.indexOf("))}", mapStart);
    const mapBlock = source.slice(mapStart, mapEnd);
    expect(mapBlock).toMatch(/\{entry\.name\}/);
    expect(mapBlock).toMatch(/entry\.maxGuests !== null &&/);
  });

  it("[pageUrl -> real external link when present, nothing invented when absent] Deluxe/Junior Suite (real pageUrl) get a link; Superior/Deluxe PMR (pageUrl: null) still render, just without one", () => {
    const mapStart = source.indexOf("message.roomCatalogue.map((entry) => (");
    const mapEnd = source.indexOf("))}", mapStart);
    const mapBlock = source.slice(mapStart, mapEnd);
    expect(mapBlock).toMatch(/entry\.pageUrl && \(/);
    expect(mapBlock).toMatch(/href=\{entry\.pageUrl\}/);
    expect(mapBlock).toMatch(/target="_blank"/);
    expect(mapBlock).toMatch(/rel="noopener noreferrer"/);
    // No fallback URL construction of any kind — a null pageUrl renders the card with no link at all, never a guessed/synthesized one.
    expect(mapBlock).not.toMatch(/pageUrl \?\? /);
  });

  it("[never duplicates the model's own prose] the catalogue card shows only name/capacity/link — no description, no photos, no price line — deliberately minimal so it complements `message.content` rather than repeating it", () => {
    const mapStart = source.indexOf("message.roomCatalogue.map((entry) => (");
    const mapEnd = source.indexOf("))}", mapStart);
    const mapBlock = source.slice(mapStart, mapEnd);
    expect(mapBlock).not.toMatch(/description/i);
    expect(mapBlock).not.toMatch(/photos/i);
    expect(mapBlock).not.toMatch(/€|\bEUR\b|\bprice\b/i);
  });
});
