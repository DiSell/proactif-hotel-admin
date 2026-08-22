import { createClient } from "@/lib/supabase/server";
import { embedText } from "./embeddings";
import type { MatchedChunk } from "@/types/database";
import type { RetrievedChunk } from "./types";

/**
 * Cosine similarity (1 - cosine distance) cutoff below which a chunk is
 * considered not relevant enough to ground an answer. This is the ONLY
 * threshold constant in the app — every caller (answerQuestion, the smoke
 * routes, tests) must import this one instead of hardcoding a number, so
 * the cutoff can never silently diverge between two code paths.
 *
 * Set to 0.6 based on real observed data from the RAG smoke tests
 * (text-embedding-3-small, French hotel FAQ content): genuinely correct
 * matches for real questions scored between ~0.60 and ~0.71 similarity — a
 * 0.75 cutoff silently fell back on questions that had a clearly relevant
 * source. Still not a "considered final" value; revisit as more real
 * conversation data comes in, and adjust only here — every caller follows.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.6;

const DEFAULT_MATCH_COUNT = 6;

export interface RetrieveKnowledgeParams {
  /** Required — there is no default and no way to call this without it. */
  hotelId: string;
  query: string;
  limit?: number;
}

/**
 * The ONLY function in the app that performs vector retrieval. Delegates to
 * match_knowledge_chunks(), whose SQL body filters by hotel_id internally —
 * this function cannot return chunks belonging to a different hotel no
 * matter how it's called, but hotelId is still a required (non-optional,
 * non-defaulted) parameter here too, so the type system rejects a call that
 * omits it before the request ever reaches the database.
 */
export async function retrieveKnowledge({
  hotelId,
  query,
  limit = DEFAULT_MATCH_COUNT,
}: RetrieveKnowledgeParams): Promise<RetrievedChunk[]> {
  if (!hotelId) {
    throw new Error("retrieveKnowledge: hotelId is required — no retrieval may run without it.");
  }

  const queryEmbedding = await embedText(query);
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("match_knowledge_chunks", {
    p_hotel_id: hotelId,
    p_query_embedding: queryEmbedding,
    p_match_count: limit,
  });

  if (error) {
    throw new Error(`retrieveKnowledge: match_knowledge_chunks failed: ${error.message}`);
  }

  return ((data ?? []) as MatchedChunk[]).map((row) => ({
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    content: row.content,
    similarity: row.similarity,
  }));
}

/** Pure — kept separate from retrieveKnowledge() so it's testable without a database or network call. */
export function selectRelevantChunks(
  chunks: RetrievedChunk[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD
): RetrievedChunk[] {
  return chunks.filter((chunk) => chunk.similarity >= threshold);
}
