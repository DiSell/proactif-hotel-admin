import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "AssistantMessageContent.tsx"), "utf8");

/**
 * MOBILE LISIBILITÉ chantier — source-level audit for the JSX-producing
 * half of AssistantMessageContent, mirroring the exact same constraint and
 * technique already established for other "use client" components in this
 * repo (see PublicWidgetChat.roomCatalogue.test.ts's own doc comment):
 * vitest's environment is "node" (no jsdom), so a real render can't be
 * exercised. The parsing logic itself IS exercised with real invocations —
 * see AssistantMessageContent.test.ts.
 */
describe("AssistantMessageContent — security & styling wiring", () => {
  it("[security] never uses the dangerouslySetInnerHTML prop anywhere in this file (doc comments may still mention the term)", () => {
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });

  it("[security] never renders an <a> tag / href — no auto-linking of model-produced URLs", () => {
    expect(source).not.toMatch(/<a\b/);
    expect(source).not.toMatch(/\bhref\s*=/);
  });

  it("[security] the only inline markup interpreted is the bold segment pattern — no italics, no headings, no raw HTML pass-through", () => {
    expect(source).toMatch(/BOLD_SEGMENT_PATTERN/);
    expect(source).not.toMatch(/^import .*(marked|remark|react-markdown)/im);
  });

  it("[Tailwind preflight] paragraphs, lists and list items all set margin:0 explicitly — preflight zeroes these by default", () => {
    expect(source).toMatch(/<p key=\{blockIndex\} style=\{\{ margin: 0,/);
    expect(source).toMatch(/<ul key=\{blockIndex\} style=\{\{ margin: 0,/);
    expect(source).toMatch(/<ol key=\{blockIndex\} style=\{\{ margin: 0,/);
  });

  it("[Tailwind preflight] bullet/numbered lists explicitly restore listStyle — preflight removes markers by default", () => {
    expect(source).toMatch(/listStyle: "disc"/);
    expect(source).toMatch(/listStyle: "decimal"/);
  });

  it("[mobile] lists use a compact, explicit vertical gap — never the browser's own (removed) default spacing", () => {
    const ulBlock = source.slice(source.indexOf("block.type === \"bullet-list\""), source.indexOf("block.type === \"numbered-list\""));
    expect(ulBlock).toMatch(/gap: 4/);
  });

  it("[no horizontal overflow] the root wrapper breaks long unbroken tokens instead of overflowing", () => {
    expect(source).toMatch(/wordBreak: "break-word"/);
  });

  it("exports the pure parsing functions used by AssistantMessageContent.test.ts, never inlines this logic only inside the component", () => {
    expect(source).toMatch(/export function parseAssistantMessageBlocks/);
    expect(source).toMatch(/export function parseInlineSegments/);
  });
});

describe("PublicWidgetChat.tsx / ChatPreview.tsx — wired to the shared renderer, assistant messages only", () => {
  function readComponent(name: string): string {
    return readFileSync(join(here, "..", "..", "features", name), "utf8");
  }

  it("[PublicWidgetChat] imports AssistantMessageContent and uses it only for role === \"assistant\"", () => {
    const widgetSource = readComponent(join("widget", "PublicWidgetChat.tsx"));
    expect(widgetSource).toMatch(/import \{ AssistantMessageContent \} from "@\/components\/ui\/AssistantMessageContent";/);
    expect(widgetSource).toMatch(/\{message\.role === "assistant" \? <AssistantMessageContent content=\{message\.content\} \/> : message\.content\}/);
  });

  it("[ChatPreview] imports AssistantMessageContent and uses it only for role === \"assistant\"", () => {
    const previewSource = readComponent(join("assistant", "ChatPreview.tsx"));
    expect(previewSource).toMatch(/import \{ AssistantMessageContent \} from "@\/components\/ui\/AssistantMessageContent";/);
    expect(previewSource).toMatch(/\{message\.role === "assistant" \? <AssistantMessageContent content=\{message\.content\} \/> : message\.content\}/);
  });

  it("[untouched] roomCatalogue / roomRecommendation / RoomPhotoModal blocks are not touched by this chantier", () => {
    const widgetSource = readComponent(join("widget", "PublicWidgetChat.tsx"));
    expect(widgetSource).toMatch(/message\.roomCatalogue && message\.roomCatalogue\.length > 0/);
    expect(widgetSource).toMatch(/setOpenRoomRecommendation\(message\.roomRecommendation \?\? null\)/);
    expect(widgetSource).toMatch(/import \{ RoomPhotoModal \} from "@\/features\/assistant\/RoomPhotoModal";/);
  });
});
