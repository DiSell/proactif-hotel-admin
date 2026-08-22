import { describe, expect, it } from "vitest";
import { DEFAULT_SIMILARITY_THRESHOLD, selectRelevantChunks } from "./retrieve";
import type { RetrievedChunk } from "./types";

function makeChunk(similarity: number, id = "chunk"): RetrievedChunk {
  return { chunkId: id, sourceId: "source", sourceTitle: "Source", content: "…", similarity };
}

describe("selectRelevantChunks", () => {
  it("keeps chunks at or above the threshold", () => {
    const chunks = [makeChunk(0.9), makeChunk(0.75)];
    expect(selectRelevantChunks(chunks, 0.75)).toHaveLength(2);
  });

  it("drops chunks below the threshold", () => {
    const chunks = [makeChunk(0.9), makeChunk(0.5)];
    expect(selectRelevantChunks(chunks, 0.75)).toEqual([chunks[0]]);
  });

  it("returns an empty array when nothing clears the threshold — this is the hallucination guard", () => {
    // Real scenario from the test plan: a source about parking only, asked
    // about pool closing time — nothing should be considered "relevant".
    const chunks = [makeChunk(0.2, "parking-chunk")];
    expect(selectRelevantChunks(chunks, DEFAULT_SIMILARITY_THRESHOLD)).toEqual([]);
  });

  it("uses DEFAULT_SIMILARITY_THRESHOLD when no threshold is passed", () => {
    const justBelow = makeChunk(DEFAULT_SIMILARITY_THRESHOLD - 0.01);
    const justAtOrAbove = makeChunk(DEFAULT_SIMILARITY_THRESHOLD);
    expect(selectRelevantChunks([justBelow, justAtOrAbove])).toEqual([justAtOrAbove]);
  });
});
