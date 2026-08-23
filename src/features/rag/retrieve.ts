import type { SupabaseClient } from "@supabase/supabase-js";
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
 * MVP value, calibrated empirically — NOT a considered-final number, and
 * NOT to be lowered further without new measurement:
 *
 * A 32-query benchmark (8 real facts x FR/EN/ES + 8 negative queries, across
 * two hotels' real content, text-embedding-3-small) measured precision and
 * recall at six candidate thresholds by sweeping retrieveKnowledge()'s raw
 * scores (nothing in production was changed to run it):
 *
 *   threshold  precision  recall
 *   0.60       100%       16.7%   <- previous value: too many real matches missed, in French too, not just cross-lingual
 *   0.58       100%       25.0%
 *   0.56       100%       33.3%
 *   0.54       100%       41.7%
 *   0.52       100%       54.2%
 *   0.50       100%       62.5%   <- current value: best recall with zero false positives observed in the sample
 *
 * Precision stayed at 100% (zero false positives) across the entire sweep,
 * so 0.50 was chosen as the most permissive value actually measured — going
 * lower would be extrapolating past real data, not reading it. Revisit with
 * a larger/more diverse benchmark before adjusting further; adjust only
 * here — every caller follows.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.5;

const DEFAULT_MATCH_COUNT = 6;

export interface RetrieveKnowledgeParams {
  /** Required — there is no default and no way to call this without it. */
  hotelId: string;
  query: string;
  limit?: number;
  /**
   * Injected Supabase client — defaults to the session-bound admin client
   * (createClient()), unchanged behavior for every existing caller. The
   * public widget's chat route passes the service-role client instead (see
   * answer.ts's answerQuestion and features/widget/publicHotel.ts): RLS on
   * knowledge_chunks, plus an explicit `revoke ... from public` on the
   * match_knowledge_chunks() RPC itself, blocks an anonymous visitor
   * entirely otherwise.
   */
  supabase?: SupabaseClient;
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
  supabase: injectedSupabase,
}: RetrieveKnowledgeParams): Promise<RetrievedChunk[]> {
  if (!hotelId) {
    throw new Error("retrieveKnowledge: hotelId is required — no retrieval may run without it.");
  }

  const queryEmbedding = await embedText(query);
  const supabase = injectedSupabase ?? (await createClient());

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
