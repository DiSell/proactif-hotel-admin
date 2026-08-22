import { describe, expect, it } from "vitest";
import { chunkText, CHUNKING_PARAMS } from "./chunk";

describe("chunkText", () => {
  it("returns nothing for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short text as a single chunk", () => {
    const chunks = chunkText("Le parking est gratuit pour tous les clients.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("parking est gratuit");
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it("preserves paragraph boundaries when packing multiple paragraphs into one chunk", () => {
    const text = ["Premier paragraphe court.", "Deuxième paragraphe court."].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain("Premier paragraphe court.");
    expect(chunks[0].content).toContain("Deuxième paragraphe court.");
  });

  it("starts a new chunk once targetSize would be exceeded, rather than splitting a paragraph that fits", () => {
    const params = { ...CHUNKING_PARAMS, targetSize: 30, overlap: 0, minChunkLength: 5 };
    const paragraphA = "Paragraphe A de taille correcte.";
    const paragraphB = "Paragraphe B de taille correcte.";
    const chunks = chunkText([paragraphA, paragraphB].join("\n\n"), params);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each paragraph appears whole in some chunk — never sliced mid-word.
    expect(chunks.some((c) => c.content.includes(paragraphA))).toBe(true);
    expect(chunks.some((c) => c.content.includes(paragraphB))).toBe(true);
  });

  it("splits a single paragraph that alone exceeds targetSize, on sentence boundaries", () => {
    const longParagraph = Array.from({ length: 20 }, (_, i) => `Phrase numéro ${i}.`).join(" ");
    const params = { ...CHUNKING_PARAMS, targetSize: 50, overlap: 0, minChunkLength: 5 };
    const chunks = chunkText(longParagraph, params);

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk still ends on a real sentence boundary (a period), never mid-sentence.
    for (const chunk of chunks) {
      const withoutOverlap = chunk.content;
      expect(withoutOverlap.trim().endsWith(".")).toBe(true);
    }
  });

  it("merges a too-small trailing chunk into its predecessor instead of leaving a tiny orphan", () => {
    const params = { ...CHUNKING_PARAMS, targetSize: 20, overlap: 0, minChunkLength: 15 };
    const text = ["Un paragraphe de taille correcte ici.", "Court."].join("\n\n");
    const chunks = chunkText(text, params);

    expect(chunks.every((c) => c.content.length >= params.minChunkLength)).toBe(true);
    expect(chunks.some((c) => c.content.includes("Court."))).toBe(true);
  });

  it("carries a bounded overlap from the end of one chunk into the start of the next", () => {
    const params = { targetSize: 15, overlap: 8, minChunkLength: 1 };
    const text = ["Paragraphe alpha ici présent.", "Paragraphe beta ici présent."].join("\n\n");
    const chunks = chunkText(text, params);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const firstChunkTail = chunks[0].content.slice(-params.overlap);
    expect(chunks[1].content).toContain(firstChunkTail);
  });

  it("assigns sequential zero-based chunkIndex values", () => {
    const params = { ...CHUNKING_PARAMS, targetSize: 20, overlap: 0, minChunkLength: 1 };
    const text = ["Alpha paragraphe complet.", "Beta paragraphe complet.", "Gamma paragraphe complet."].join("\n\n");
    const chunks = chunkText(text, params);

    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });
});
