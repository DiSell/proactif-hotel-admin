import { describe, expect, it } from "vitest";
import { parseAssistantMessageBlocks, parseInlineSegments } from "./AssistantMessageContent";

/**
 * MOBILE LISIBILITÉ chantier — pure-logic tests for the parsing that
 * decides paragraph vs. list vs. bold. The JSX-producing component itself
 * is covered by AssistantMessageContent.wiring.test.ts (source-level —
 * see that file's own doc comment for why: no jsdom in this repo).
 */
describe("parseAssistantMessageBlocks", () => {
  it("[A] a single short line stays a single paragraph — no artificial structure", () => {
    expect(parseAssistantMessageBlocks("Bonjour")).toEqual([{ type: "paragraph", lines: ["Bonjour"] }]);
  });

  it("[E] a simple factual sentence stays a single paragraph too", () => {
    expect(parseAssistantMessageBlocks("Le 1837 compte 36 logements.")).toEqual([
      { type: "paragraph", lines: ["Le 1837 compte 36 logements."] },
    ]);
  });

  it("[B] intro paragraph + bullet list are two distinct blocks", () => {
    const blocks = parseAssistantMessageBlocks("Le 1837 propose :\n\n- **Mini-suite**\n- **Standard**");
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["Le 1837 propose :"] },
      { type: "bullet-list", items: ["**Mini-suite**", "**Standard**"] },
    ]);
  });

  it("[C] two paragraphs separated by a blank line become two separate blocks", () => {
    const blocks = parseAssistantMessageBlocks("Premier paragraphe.\n\nDeuxième paragraphe.");
    expect(blocks).toEqual([
      { type: "paragraph", lines: ["Premier paragraphe."] },
      { type: "paragraph", lines: ["Deuxième paragraphe."] },
    ]);
  });

  it("recognizes a bullet list using '*' markers too", () => {
    const blocks = parseAssistantMessageBlocks("* Un\n* Deux");
    expect(blocks).toEqual([{ type: "bullet-list", items: ["Un", "Deux"] }]);
  });

  it("recognizes a numbered list ('1.' / '2)')", () => {
    expect(parseAssistantMessageBlocks("1. Un\n2. Deux")).toEqual([{ type: "numbered-list", items: ["Un", "Deux"] }]);
    expect(parseAssistantMessageBlocks("1) Un\n2) Deux")).toEqual([{ type: "numbered-list", items: ["Un", "Deux"] }]);
  });

  it("a block mixing prose and a single dash line is never mistaken for a list — every line must match", () => {
    const blocks = parseAssistantMessageBlocks("Voici une phrase - avec un tiret au milieu.");
    expect(blocks).toEqual([{ type: "paragraph", lines: ["Voici une phrase - avec un tiret au milieu."] }]);
  });

  it("a paragraph with an internal single line break keeps both lines (soft break), never merged into one", () => {
    const blocks = parseAssistantMessageBlocks("Ligne 1\nLigne 2");
    expect(blocks).toEqual([{ type: "paragraph", lines: ["Ligne 1", "Ligne 2"] }]);
  });

  it("[D] HTML-looking content is treated as plain text at the parsing level — never stripped, never specially interpreted", () => {
    const blocks = parseAssistantMessageBlocks("<script>alert(1)</script> et <b>gras</b> ?");
    expect(blocks).toEqual([{ type: "paragraph", lines: ["<script>alert(1)</script> et <b>gras</b> ?"] }]);
  });

  it("empty content produces no blocks", () => {
    expect(parseAssistantMessageBlocks("")).toEqual([]);
    expect(parseAssistantMessageBlocks("   \n\n  ")).toEqual([]);
  });
});

describe("parseInlineSegments", () => {
  it("plain text with no bold marker is a single non-bold segment", () => {
    expect(parseInlineSegments("Bonjour")).toEqual([{ text: "Bonjour", bold: false }]);
  });

  it("a **bold** segment is isolated and marked bold, surrounding text stays plain", () => {
    expect(parseInlineSegments("La **Junior Suite** est disponible")).toEqual([
      { text: "La ", bold: false },
      { text: "Junior Suite", bold: true },
      { text: " est disponible", bold: false },
    ]);
  });

  it("multiple bold segments in the same line are each isolated", () => {
    expect(parseInlineSegments("**Deluxe** ou **Superior**")).toEqual([
      { text: "Deluxe", bold: true },
      { text: " ou ", bold: false },
      { text: "Superior", bold: true },
    ]);
  });

  it("[D] a literal HTML tag inside the text is never interpreted — it stays a plain-text segment", () => {
    expect(parseInlineSegments("<b>gras</b> pas vraiment")).toEqual([{ text: "<b>gras</b> pas vraiment", bold: false }]);
  });

  it("an unmatched '**' (no closing pair) is left as literal text, never crashes", () => {
    expect(parseInlineSegments("prix ** non fermé")).toEqual([{ text: "prix ** non fermé", bold: false }]);
  });
});
