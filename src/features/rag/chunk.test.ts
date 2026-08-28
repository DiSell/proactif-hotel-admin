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

describe("chunkText — heading-aware sections", () => {
  it("keeps a headingless text byte-for-byte identical to the pre-heading-aware behavior (one section, no metadata.heading)", () => {
    const text = ["Premier paragraphe.", "Deuxième paragraphe."].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(text);
    expect(chunks[0].metadata).toEqual({});
  });

  it("never merges two sections with different headings, even when both are far under targetSize", () => {
    const text = ["# Parking", "Le parking est gratuit.", "# Aéroport", "L'aéroport est à 10 km."].join("\n\n");
    const params = { ...CHUNKING_PARAMS, targetSize: 800, overlap: 0, minChunkLength: 5 };
    const chunks = chunkText(text, params);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).toContain("# Parking");
    expect(chunks[0].content).toContain("Le parking est gratuit.");
    expect(chunks[0].content).not.toContain("Aéroport");
    expect(chunks[1].content).toContain("# Aéroport");
    expect(chunks[1].content).toContain("L'aéroport est à 10 km.");
    expect(chunks[1].content).not.toContain("Le parking est gratuit.");
  });

  it("mergeSmallChunks never merges a tiny chunk from one heading's section into a different heading's section", () => {
    // "OK." alone is under minChunkLength (40) and would normally be glued
    // to whatever chunk precedes it — but it belongs to "# Deuxième", not
    // "# Premier", so it must never end up inside the Premier chunk.
    const text = ["# Premier", "Un paragraphe de taille tout à fait correcte ici.", "# Deuxième", "OK."].join("\n\n");
    const chunks = chunkText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks[0].content).not.toContain("OK.");
    expect(chunks[1].content).toContain("# Deuxième");
    expect(chunks[1].content).toContain("OK.");
  });

  it("overlap never carries text across a heading boundary", () => {
    const params = { targetSize: 15, overlap: 8, minChunkLength: 1 };
    const text = [
      "# Section A",
      "Paragraphe alpha ici présent.",
      "Paragraphe alpha suite ici.",
      "# Section B",
      "Paragraphe beta ici présent.",
    ].join("\n\n");
    const chunks = chunkText(text, params);

    const lastSectionAChunk = chunks.filter((c) => c.content.includes("# Section A")).at(-1)!;
    const firstSectionBChunk = chunks.find((c) => c.content.includes("# Section B"))!;
    // Section A's own tail overlaps into A's own next chunk (normal, within-section behavior) —
    // but nothing from Section A's body ever appears inside a Section B chunk.
    expect(firstSectionBChunk.content).not.toContain("alpha");
    expect(lastSectionAChunk.content).not.toContain("beta");
  });

  it("the section's heading accompanies EVERY chunk that section produces, not just the first — a large section still gets split on targetSize", () => {
    const longBody = Array.from({ length: 30 }, (_, i) => `Phrase informative numéro ${i} sur ce sujet précis.`).join("\n\n");
    const text = `# Grande section\n\n${longBody}`;
    const params = { ...CHUNKING_PARAMS, targetSize: 100, overlap: 0, minChunkLength: 5 };
    const chunks = chunkText(text, params);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content).toContain("# Grande section");
      expect(chunk.metadata).toEqual({ heading: "Grande section" });
    }
  });

  it("never duplicates the heading line within a single chunk (once, not twice via packing/overlap)", () => {
    const params = { ...CHUNKING_PARAMS, targetSize: 60, overlap: 20, minChunkLength: 5 };
    const text = ["# Une section", "Premier paragraphe de contenu.", "Deuxième paragraphe de contenu additionnel."].join("\n\n");
    const chunks = chunkText(text, params);

    for (const chunk of chunks) {
      const occurrences = chunk.content.split("# Une section").length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it("content before the first heading forms its own headingless section — never silently attached to the next heading's section", () => {
    const text = ["Introduction générale.", "# Détails", "Contenu détaillé."].join("\n\n");
    const chunks = chunkText(text);

    const introChunk = chunks.find((c) => c.content.includes("Introduction générale"))!;
    expect(introChunk.content).not.toContain("# Détails");
    expect(introChunk.metadata).toEqual({});
  });

  it("a heading immediately followed by another heading (no body text) produces no empty chunk for it", () => {
    const text = ["# Vide", "# Avec contenu", "Du texte ici."].join("\n\n");
    const chunks = chunkText(text);

    expect(chunks.every((c) => c.content.trim().length > 0)).toBe(true);
    expect(chunks.some((c) => c.content.includes("# Vide") && !c.content.includes("Du texte ici"))).toBe(false);
  });

  it("still splits a single oversized section on sentence boundaries within that section, exactly like an oversized paragraph today", () => {
    const longParagraph = Array.from({ length: 20 }, (_, i) => `Phrase numéro ${i}.`).join(" ");
    const text = `# Titre\n\n${longParagraph}`;
    const params = { ...CHUNKING_PARAMS, targetSize: 50, overlap: 0, minChunkLength: 5 };
    const chunks = chunkText(text, params);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Body (after the heading line) still ends on a real sentence boundary.
      const body = chunk.content.replace(/^# Titre\n\n/, "");
      expect(body.trim().endsWith(".")).toBe(true);
    }
  });
});
