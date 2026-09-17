import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  fetchAccommodationSourceChunks,
  HYBRID_LEXICAL_HIGH,
  HYBRID_VECTOR_FLOOR,
  MAX_DEDICATED_SOURCE_CHUNKS,
  mergeGuaranteedChunks,
  retrieveKnowledge,
  retrieveKnowledgeHybrid,
  selectHybridRelevantChunks,
  selectRelevantChunks,
} from "./retrieve";
import type { RetrievedChunk } from "./types";

vi.mock("./embeddings", () => ({ embedText: vi.fn(async () => [0.1, 0.2, 0.3]) }));

function makeChunk(similarity: number, id = "chunk"): RetrievedChunk {
  return { chunkId: id, sourceId: "source", sourceTitle: "Source", content: "…", similarity, sourceUrl: null, lastSyncedAt: null };
}

function makeHybridChunk(similarity: number, lexicalScore: number, id = "chunk"): RetrievedChunk {
  return {
    chunkId: id,
    sourceId: "source",
    sourceTitle: "Source",
    content: "…",
    similarity,
    lexicalScore,
    sourceUrl: null,
    lastSyncedAt: null,
  };
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

/**
 * selectHybridRelevantChunks — pure decision logic from the hybrid
 * retrieval audit (3 explicit rules, never a weighted average). The RPC
 * itself (match_knowledge_chunks_hybrid, 0013_hybrid_retrieval.sql) —
 * hotel_id isolation, inactive-source exclusion, and chunk-level
 * deduplication between the vector and lexical candidate pools — is
 * Supabase-touching and covered instead by
 * supabase/tests/hybrid_retrieval_check.sql, same split as every other
 * RPC in this codebase (see e.g. src/lib/auth/session.test.ts's own
 * comment on this pattern).
 */
describe("selectHybridRelevantChunks", () => {
  it("[Rule 1] vector_score >= 0.50 is accepted exactly as selectRelevantChunks alone would — lexical is irrelevant here", () => {
    const chunk = makeHybridChunk(0.9, 0);
    expect(selectHybridRelevantChunks([chunk])).toEqual([chunk]);
  });

  it("[Rule 1 == today] for any set of chunks, selectHybridRelevantChunks never accepts fewer chunks than plain selectRelevantChunks would on the same vector scores", () => {
    const chunks = [makeChunk(0.9, "a"), makeChunk(0.3, "b"), makeChunk(0.6, "c")];
    const legacy = selectRelevantChunks(chunks, DEFAULT_SIMILARITY_THRESHOLD).map((c) => c.chunkId);
    const hybrid = selectHybridRelevantChunks(chunks).map((c) => c.chunkId);
    expect(legacy.every((id) => hybrid.includes(id))).toBe(true);
  });

  it("[Rule 2] vector < 0.50 but vector reasonable + lexical very strong is accepted by the hybrid path — the entire point of this feature", () => {
    const chunk = makeHybridChunk(0.35, 0.8, "private-parking-chunk");
    expect(selectRelevantChunks([chunk])).toEqual([]); // legacy would drop it
    expect(selectHybridRelevantChunks([chunk])).toEqual([chunk]); // hybrid recovers it
  });

  it("[Rule 3] lexical very strong but vector completely off-topic (below the floor) is refused — a strong keyword match alone is never enough", () => {
    const chunk = makeHybridChunk(0.05, 1.0, "off-topic-but-keyword-heavy");
    expect(selectHybridRelevantChunks([chunk])).toEqual([]);
  });

  it("[Rule 3] vector reasonable (clears the floor) but lexical insufficient is refused", () => {
    const chunk = makeHybridChunk(0.3, 0.4, "reasonable-vector-weak-lexical");
    expect(selectHybridRelevantChunks([chunk])).toEqual([]);
  });

  it("[Rule 3 / fallback] no candidate clears either rule — the result is empty, exactly the existing hallucination guard", () => {
    const chunks = [makeHybridChunk(0.2, 0.1, "a"), makeHybridChunk(0.1, 0.3, "b")];
    expect(selectHybridRelevantChunks(chunks)).toEqual([]);
  });

  it("[legacy chunk, no lexicalScore] a chunk from the pre-hybrid path (lexicalScore undefined) can still be accepted by Rule 1, never by Rule 2 alone", () => {
    const accepted = makeChunk(0.7); // no lexicalScore field at all
    const refused = makeChunk(0.3); // below vector threshold, no lexicalScore to save it
    expect(selectHybridRelevantChunks([accepted])).toEqual([accepted]);
    expect(selectHybridRelevantChunks([refused])).toEqual([]);
  });

  describe("threshold boundaries — exact edges", () => {
    it("vector_score exactly == DEFAULT_SIMILARITY_THRESHOLD is accepted (>=, not >)", () => {
      const chunk = makeHybridChunk(DEFAULT_SIMILARITY_THRESHOLD, 0);
      expect(selectHybridRelevantChunks([chunk])).toEqual([chunk]);
    });

    it("vector_score one step below DEFAULT_SIMILARITY_THRESHOLD, with no lexical help, is refused", () => {
      const chunk = makeHybridChunk(DEFAULT_SIMILARITY_THRESHOLD - 0.0001, 0);
      expect(selectHybridRelevantChunks([chunk])).toEqual([]);
    });

    it("vector_score exactly == HYBRID_VECTOR_FLOOR with lexical_score exactly == HYBRID_LEXICAL_HIGH is accepted (both >=, not >)", () => {
      const chunk = makeHybridChunk(HYBRID_VECTOR_FLOOR, HYBRID_LEXICAL_HIGH);
      expect(selectHybridRelevantChunks([chunk])).toEqual([chunk]);
    });

    it("vector_score one step below HYBRID_VECTOR_FLOOR, even with lexical_score == 1.0, is refused — the floor is a hard requirement, not skippable via a stronger lexical score", () => {
      const chunk = makeHybridChunk(HYBRID_VECTOR_FLOOR - 0.0001, 1.0);
      expect(selectHybridRelevantChunks([chunk])).toEqual([]);
    });

    it("lexical_score one step below HYBRID_LEXICAL_HIGH, even with vector_score comfortably above the floor, is refused", () => {
      const chunk = makeHybridChunk(0.49, HYBRID_LEXICAL_HIGH - 0.0001);
      expect(selectHybridRelevantChunks([chunk])).toEqual([]);
    });
  });

  it("[configurable, not hardcoded] explicit options override the provisional defaults — callers/tests can calibrate without editing retrieve.ts", () => {
    const chunk = makeHybridChunk(0.2, 0.5);
    expect(selectHybridRelevantChunks([chunk])).toEqual([]); // fails provisional defaults
    expect(selectHybridRelevantChunks([chunk], { vectorFloor: 0.1, lexicalHigh: 0.4 })).toEqual([chunk]); // passes relaxed ones
    expect(selectHybridRelevantChunks([chunk], { vectorThreshold: 0.15 })).toEqual([chunk]); // or Rule 1 alone, relaxed
  });

  it("[mixed batch] filters a realistic mixed set down to exactly the chunks either rule accepts, preserving order", () => {
    const strongVector = makeHybridChunk(0.8, 0, "strong-vector");
    const strongLexicalOnly = makeHybridChunk(0.2, 0.9, "strong-lexical-only");
    const bothWeak = makeHybridChunk(0.3, 0.2, "both-weak");
    const offTopic = makeHybridChunk(0.05, 0.95, "off-topic-keyword-spam");

    const result = selectHybridRelevantChunks([strongVector, strongLexicalOnly, bothWeak, offTopic]);

    expect(result.map((c) => c.chunkId)).toEqual(["strong-vector", "strong-lexical-only"]);
  });
});

/**
 * RAG freshness — source_url/last_synced_at (0016_rag_freshness.sql) are
 * mapped straight from the RPC row onto RetrievedChunk, same real-invocation
 * style as the rest of this file: the supabase client is injectable
 * (RetrieveKnowledgeParams.supabase), so a fake `{ rpc }` stands in for a
 * real one without touching @/lib/supabase/server. The RPC's own behavior
 * (tenant isolation, scoring, grants) is covered by
 * supabase/tests/rag_freshness_check.sql, not here — this only proves the
 * TypeScript mapping is correct.
 */
describe("retrieveKnowledge / retrieveKnowledgeHybrid — source_url/last_synced_at mapping", () => {
  it("[retrieveKnowledge] maps source_url and last_synced_at straight through from the RPC row", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          chunk_id: "c1",
          source_id: "s1",
          source_title: "Le Bistrot",
          content: "…",
          similarity: 0.9,
          source_url: "https://le1837.example.com/en",
          last_synced_at: "2026-08-22T17:25:43.886Z",
        },
      ],
      error: null,
    }));
    const chunks = await retrieveKnowledge({ hotelId: "hotel-a", query: "horaires", supabase: { rpc } as never });
    expect(chunks).toEqual([
      {
        chunkId: "c1",
        sourceId: "s1",
        sourceTitle: "Le Bistrot",
        content: "…",
        similarity: 0.9,
        sourceUrl: "https://le1837.example.com/en",
        lastSyncedAt: "2026-08-22T17:25:43.886Z",
      },
    ]);
  });

  it("[retrieveKnowledge] a non-URL source (text/faq/internal_note/document) maps to sourceUrl: null, never fabricated", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ chunk_id: "c1", source_id: "s1", source_title: "FAQ", content: "…", similarity: 0.9, source_url: null, last_synced_at: null }],
      error: null,
    }));
    const chunks = await retrieveKnowledge({ hotelId: "hotel-a", query: "horaires", supabase: { rpc } as never });
    expect(chunks[0].sourceUrl).toBeNull();
    expect(chunks[0].lastSyncedAt).toBeNull();
  });

  it("[retrieveKnowledgeHybrid] maps source_url and last_synced_at straight through from the RPC row, alongside the existing vector/lexical scores", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          chunk_id: "c1",
          source_id: "s1",
          source_title: "Le Bistrot",
          content: "…",
          vector_score: 0.8,
          lexical_score: 0.5,
          source_url: "https://le1837.example.com/en",
          last_synced_at: "2026-08-22T17:25:43.886Z",
        },
      ],
      error: null,
    }));
    const chunks = await retrieveKnowledgeHybrid({ hotelId: "hotel-a", query: "horaires", supabase: { rpc } as never });
    expect(chunks).toEqual([
      {
        chunkId: "c1",
        sourceId: "s1",
        sourceTitle: "Le Bistrot",
        content: "…",
        similarity: 0.8,
        lexicalScore: 0.5,
        sourceUrl: "https://le1837.example.com/en",
        lastSyncedAt: "2026-08-22T17:25:43.886Z",
      },
    ]);
  });
});

/**
 * fetchAccommodationSourceChunks — the OPTION 2 mechanism: additive, bounded
 * retrieval scoped to a single already-identified accommodation's own
 * dedicated knowledge_source. Real-invocation style with a hand-built fake
 * Supabase client, same discipline as this file's own retrieveKnowledge*
 * tests above and every route test in this codebase — the chain shape
 * (.select().eq().eq().eq().maybeSingle() then .select().eq().eq().order().limit())
 * mirrors the real implementation exactly.
 */
function makeFakeSupabase(config: { source: Record<string, unknown> | null; chunks: Record<string, unknown>[] | null }) {
  const knowledgeSourcesBuilder = {
    select: vi.fn(() => knowledgeSourcesBuilder),
    eq: vi.fn(() => knowledgeSourcesBuilder),
    maybeSingle: vi.fn(async () => ({ data: config.source, error: null })),
  };
  const knowledgeChunksBuilder = {
    select: vi.fn(() => knowledgeChunksBuilder),
    eq: vi.fn(() => knowledgeChunksBuilder),
    order: vi.fn(() => knowledgeChunksBuilder),
    limit: vi.fn(async () => ({ data: config.chunks, error: null })),
  };
  const from = vi.fn((table: string) => {
    if (table === "knowledge_sources") return knowledgeSourcesBuilder;
    if (table === "knowledge_chunks") return knowledgeChunksBuilder;
    throw new Error(`unexpected table: ${table}`);
  });
  return { from, knowledgeSourcesBuilder, knowledgeChunksBuilder } as const;
}

describe("fetchAccommodationSourceChunks", () => {
  it("[happy path] resolves the dedicated source by EXACT source_url match, returns its chunks mapped to RetrievedChunk, ordered by chunk_index", async () => {
    const fake = makeFakeSupabase({
      source: { id: "src-deluxe", title: "Deluxe — EN", source_url: "https://www.le1837.com/en/deluxe", last_synced_at: "2026-08-22T17:25:45.154Z" },
      chunks: [
        { id: "chunk-0", content: "Return\n\n1 - 4 persons\n45 m²..." },
        { id: "chunk-1", content: "Deluxe\nThe Deluxe Suite can accommodate up to 4 people... reversible air conditioning..." },
      ],
    });

    const result = await fetchAccommodationSourceChunks({
      hotelId: "hotel-1",
      sourceUrl: "https://www.le1837.com/en/deluxe",
      supabase: fake as never,
    });

    expect(result).toEqual([
      {
        chunkId: "chunk-0",
        sourceId: "src-deluxe",
        sourceTitle: "Deluxe — EN",
        content: "Return\n\n1 - 4 persons\n45 m²...",
        similarity: 1,
        lexicalScore: undefined,
        sourceUrl: "https://www.le1837.com/en/deluxe",
        lastSyncedAt: "2026-08-22T17:25:45.154Z",
      },
      {
        chunkId: "chunk-1",
        sourceId: "src-deluxe",
        sourceTitle: "Deluxe — EN",
        content: "Deluxe\nThe Deluxe Suite can accommodate up to 4 people... reversible air conditioning...",
        similarity: 1,
        lexicalScore: undefined,
        sourceUrl: "https://www.le1837.com/en/deluxe",
        lastSyncedAt: "2026-08-22T17:25:45.154Z",
      },
    ]);
  });

  it("[bounded] the chunk query is capped at MAX_DEDICATED_SOURCE_CHUNKS — a single dedicated page can never inject unbounded content", async () => {
    const fake = makeFakeSupabase({ source: { id: "s1", title: "T", source_url: "u", last_synced_at: null }, chunks: [] });
    await fetchAccommodationSourceChunks({ hotelId: "hotel-1", sourceUrl: "u", supabase: fake as never });
    expect(fake.knowledgeChunksBuilder.limit).toHaveBeenCalledWith(MAX_DEDICATED_SOURCE_CHUNKS);
  });

  it("[no dedicated source found] returns [] — never an error, a category can have a source_url before it's ever been crawled/indexed", async () => {
    const fake = makeFakeSupabase({ source: null, chunks: null });
    const result = await fetchAccommodationSourceChunks({ hotelId: "hotel-1", sourceUrl: "https://unindexed.example.com", supabase: fake as never });
    expect(result).toEqual([]);
  });

  it("[source found but no chunks yet] returns []", async () => {
    const fake = makeFakeSupabase({ source: { id: "s1", title: "T", source_url: "u", last_synced_at: null }, chunks: [] });
    const result = await fetchAccommodationSourceChunks({ hotelId: "hotel-1", sourceUrl: "u", supabase: fake as never });
    expect(result).toEqual([]);
  });
});

describe("mergeGuaranteedChunks", () => {
  function chunk(id: string): RetrievedChunk {
    return { chunkId: id, sourceId: "s", sourceTitle: "T", content: "…", similarity: 0.9, sourceUrl: null, lastSyncedAt: null };
  }

  it("[additive] guaranteed chunks are placed FIRST, ahead of the normally-selected ones", () => {
    const selected = [chunk("a"), chunk("b")];
    const guaranteed = [chunk("g1")];
    expect(mergeGuaranteedChunks(selected, guaranteed).map((c) => c.chunkId)).toEqual(["g1", "a", "b"]);
  });

  it("[dedup] a guaranteed chunk already present in the normally-selected list is never duplicated", () => {
    const selected = [chunk("a"), chunk("shared")];
    const guaranteed = [chunk("shared"), chunk("g1")];
    expect(mergeGuaranteedChunks(selected, guaranteed).map((c) => c.chunkId)).toEqual(["g1", "a", "shared"]);
  });

  it("[never removes anything] every chunk selectHybridRelevantChunks already accepted survives the merge", () => {
    const selected = [chunk("a"), chunk("b"), chunk("c")];
    expect(mergeGuaranteedChunks(selected, [])).toEqual(selected);
  });

  it("[empty guaranteed, identity] returns the exact same selected array reference when there's nothing to add", () => {
    const selected = [chunk("a")];
    expect(mergeGuaranteedChunks(selected, [])).toBe(selected);
  });
});
