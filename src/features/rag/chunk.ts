import type { Chunk } from "./types";

/**
 * Centralized so nobody has to hunt through the ingestion code to find a
 * magic 500/800/whatever — tune these three numbers, nothing else.
 */
export const CHUNKING_PARAMS = {
  /** Rough target size per chunk, in characters. */
  targetSize: 800,
  /** Characters of overlap carried from the end of one chunk into the next. */
  overlap: 100,
  /** Chunks shorter than this get merged into the previous one instead of standing alone. */
  minChunkLength: 40,
};

/**
 * Matches one heading marker paragraph as produced by
 * features/crawler/extract.ts's markHeadingsForStructuredText — a paragraph
 * whose ENTIRE content is "#".repeat(level) + " " + heading text, nothing
 * else (that function always isolates it with blank lines on both sides
 * before this module ever sees it, so after the `\n{2,}` paragraph split
 * below it always arrives as its own standalone paragraph). Plain
 * text/faq/internal_note sources (features/rag/ingest.ts's
 * buildSourceText) never contain such a line unless an author happens to
 * type one starting a paragraph — an accepted, narrow tradeoff: a stray
 * "# ..." line in hand-authored content would be read as a heading too.
 */
const HEADING_LINE = /^(#{1,6})\s+(.+)$/;

interface ParsedSection {
  /** The heading's own text, without the "#" markers — null for content before the first heading (or the only section, for headingless input). */
  heading: string | null;
  /** The exact "#... heading" line, prefixed onto every chunk this section produces — null iff heading is null. */
  headingLine: string | null;
  /** Every paragraph belonging to this section, in order — never includes headingLine itself. */
  paragraphs: string[];
}

/**
 * Splits a flat paragraph list into sections at each heading-marker
 * paragraph. A heading change is the ONLY section boundary — no semantic
 * classification, no guessing. Content before the first heading (or ALL
 * content, for headingless input) becomes one leading section with
 * heading: null, so this degrades to a single section — i.e. IDENTICAL
 * behavior to the pre-heading-aware chunker — whenever the input contains
 * no heading markers at all.
 */
function splitIntoSections(paragraphs: string[]): ParsedSection[] {
  const sections: ParsedSection[] = [{ heading: null, headingLine: null, paragraphs: [] }];
  for (const paragraph of paragraphs) {
    const match = paragraph.match(HEADING_LINE);
    if (match) {
      sections.push({ heading: match[2].trim(), headingLine: paragraph, paragraphs: [] });
    } else {
      sections[sections.length - 1].paragraphs.push(paragraph);
    }
  }
  // Drop a leading section that's empty in every sense — text that starts
  // directly with a heading, nothing before it (the common case for a
  // crawled page: see extract.ts, a heading is nearly always the first
  // paragraph of `main`). Keeps chunkIndex/output free of a phantom
  // zero-chunk section; a genuinely headingless input never matches this
  // (its lone section always has paragraphs).
  return sections[0].heading === null && sections[0].paragraphs.length === 0 ? sections.slice(1) : sections;
}

/**
 * Packs, merges, and overlaps EACH section independently — a heading
 * change is a hard wall: packParagraphs/mergeSmallChunks/applyOverlap
 * (all three untouched below) never see paragraphs from two different
 * sections in the same call, so a chunk can never straddle a heading
 * boundary and overlap can never carry text across one either. The
 * section's heading is prepended to EVERY chunk it produces (not just the
 * first) — a long section split into several ~targetSize chunks would
 * otherwise leave later chunks with no topic context at all once
 * retrieved in isolation, which is exactly the failure this whole change
 * exists to fix. Prepending happens AFTER overlap is computed, from
 * BODY TEXT ONLY, so the heading itself is never duplicated within a
 * chunk and never becomes part of what the next chunk's overlap carries
 * forward.
 *
 * A section with no body paragraphs at all (a heading immediately
 * followed by another heading, or trailing at end of document) produces
 * zero chunks — a heading with nothing to say carries no retrievable
 * information and would only risk a false-positive match on its own.
 */
function chunkSections(sections: ParsedSection[], params: typeof CHUNKING_PARAMS): Chunk[] {
  const contents: string[] = [];
  const headingsByContent: (string | null)[] = [];

  for (const section of sections) {
    const rawChunks = packParagraphs(section.paragraphs, params.targetSize);
    const merged = mergeSmallChunks(rawChunks, params.minChunkLength);
    const withOverlap = applyOverlap(merged, params.overlap);

    for (const body of withOverlap) {
      contents.push(section.headingLine ? `${section.headingLine}\n\n${body}` : body);
      headingsByContent.push(section.heading);
    }
  }

  return contents.map((content, index) => ({
    content,
    chunkIndex: index,
    tokenCount: estimateTokenCount(content),
    metadata: headingsByContent[index] ? { heading: headingsByContent[index] } : {},
  }));
}

/**
 * Paragraph-aware, heading-aware chunking: packs whole paragraphs up to
 * targetSize, splits only a paragraph that alone exceeds targetSize (on
 * sentence boundaries), merges any resulting tiny trailing chunk into its
 * neighbor, and carries a bounded overlap from each chunk's tail into the
 * next chunk's head so a boundary never abruptly cuts off context — all
 * exactly as before, EXCEPT that a heading-marker paragraph (see
 * HEADING_LINE) now always starts a new section, and none of packing,
 * merging, or overlap ever crosses a section boundary (see chunkSections).
 *
 * For input with no heading markers — every existing caller before this
 * change, and still every plain text/faq/internal_note source today —
 * splitIntoSections produces exactly one section holding every paragraph,
 * so this is byte-for-byte the same output as before this function grew
 * heading-awareness. No new exported function, no signature change: a
 * single `chunkText(text, params)` remains the entire public API.
 */
export function chunkText(text: string, params: typeof CHUNKING_PARAMS = CHUNKING_PARAMS): Chunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [];

  const sections = splitIntoSections(paragraphs);
  return chunkSections(sections, params);
}

function packParagraphs(paragraphs: string[], targetSize: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > targetSize) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitOversizedParagraph(paragraph, targetSize));
      continue;
    }

    if (current && current.length + paragraph.length + 2 > targetSize) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitOversizedParagraph(paragraph: string, targetSize: number): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > targetSize) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

function mergeSmallChunks(chunks: string[], minChunkLength: number): string[] {
  const merged: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length < minChunkLength && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  return merged;
}

function applyOverlap(chunks: string[], overlap: number): string[] {
  if (overlap <= 0) return chunks;
  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;
    const tail = chunks[index - 1].slice(-overlap);
    return `${tail}\n\n${chunk}`;
  });
}

/** ~4 chars/token heuristic for French/English prose — good enough for cost tracking, not exact billing. */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
