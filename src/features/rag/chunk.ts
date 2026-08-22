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
 * Paragraph-aware chunking: packs whole paragraphs up to targetSize,
 * splits only a paragraph that alone exceeds targetSize (on sentence
 * boundaries), merges any resulting tiny trailing chunk into its neighbor,
 * and finally carries a bounded overlap from each chunk's tail into the
 * next chunk's head so a boundary never abruptly cuts off context.
 */
export function chunkText(text: string, params: typeof CHUNKING_PARAMS = CHUNKING_PARAMS): Chunk[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return [];

  const rawChunks = packParagraphs(paragraphs, params.targetSize);
  const merged = mergeSmallChunks(rawChunks, params.minChunkLength);
  const withOverlap = applyOverlap(merged, params.overlap);

  return withOverlap.map((content, index) => ({
    content,
    chunkIndex: index,
    tokenCount: estimateTokenCount(content),
    metadata: {},
  }));
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
