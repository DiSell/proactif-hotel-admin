import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { embedText } from "./embeddings";
import type { HybridMatchedChunk, MatchedChunk } from "@/types/database";
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
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }));
}

/** Pure — kept separate from retrieveKnowledge() so it's testable without a database or network call. */
export function selectRelevantChunks(
  chunks: RetrievedChunk[],
  threshold: number = DEFAULT_SIMILARITY_THRESHOLD
): RetrievedChunk[] {
  return chunks.filter((chunk) => chunk.similarity >= threshold);
}

/**
 * Rule 2's vector floor ("reasonable", not "confirmed relevant on its
 * own") and lexical bar ("very strong coverage"), from the hybrid
 * retrieval audit. NOT calibrated the way DEFAULT_SIMILARITY_THRESHOLD
 * was (see that constant's own 32-query benchmark comment) — these are
 * PROVISIONAL values carried over from that audit's illustrative
 * benchmark for a first working implementation. Revisit with a real
 * calibration pass (same methodology: sweep candidate values against a
 * labeled benchmark, measure precision/recall) before trusting them as
 * anything more than "good enough to ship and keep measuring". Exported
 * so selectHybridRelevantChunks's defaults are never a second hardcoded
 * number a future change could silently diverge from.
 */
export const HYBRID_VECTOR_FLOOR = 0.15;
export const HYBRID_LEXICAL_HIGH = 0.6;

export type RetrieveKnowledgeHybridParams = RetrieveKnowledgeParams;

/**
 * Vector + lexical retrieval via match_knowledge_chunks_hybrid()
 * (0013_hybrid_retrieval.sql) — the union of the vector-similarity top-k
 * AND the lexical-coverage top-k for this hotel, each row carrying BOTH
 * scores (never one defaulted to 0 for a candidate that only entered via
 * the other channel — see the RPC's own comment). Does not itself decide
 * accept/fallback; pass the result to selectHybridRelevantChunks for that.
 *
 * match_knowledge_chunks() (above) is untouched and still fully usable —
 * this is an additional function, not a replacement of it at the RPC
 * level. answerQuestion (answer.ts) is what actually switches which one
 * it calls.
 */
export async function retrieveKnowledgeHybrid({
  hotelId,
  query,
  limit = DEFAULT_MATCH_COUNT,
  supabase: injectedSupabase,
}: RetrieveKnowledgeHybridParams): Promise<RetrievedChunk[]> {
  if (!hotelId) {
    throw new Error("retrieveKnowledgeHybrid: hotelId is required — no retrieval may run without it.");
  }

  const queryEmbedding = await embedText(query);
  const supabase = injectedSupabase ?? (await createClient());

  const { data, error } = await supabase.rpc("match_knowledge_chunks_hybrid", {
    p_hotel_id: hotelId,
    p_query_embedding: queryEmbedding,
    p_query_text: query,
    p_match_count: limit,
  });

  if (error) {
    throw new Error(`retrieveKnowledgeHybrid: match_knowledge_chunks_hybrid failed: ${error.message}`);
  }

  return ((data ?? []) as HybridMatchedChunk[]).map((row) => ({
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceTitle: row.source_title,
    content: row.content,
    similarity: row.vector_score,
    lexicalScore: row.lexical_score,
    sourceUrl: row.source_url,
    lastSyncedAt: row.last_synced_at,
  }));
}

export interface SelectHybridRelevantChunksOptions {
  /** Rule 1 — identical meaning and default to selectRelevantChunks' own threshold; the vector-alone path is untouched by this rule. */
  vectorThreshold?: number;
  /** Rule 2's floor — see HYBRID_VECTOR_FLOOR's own doc comment (provisional). */
  vectorFloor?: number;
  /** Rule 2's bar — see HYBRID_LEXICAL_HIGH's own doc comment (provisional). */
  lexicalHigh?: number;
}

/**
 * The three-rule decision from the hybrid retrieval audit, applied as a
 * pure filter — same shape/contract as selectRelevantChunks (an array in,
 * the relevant subset out), so every existing downstream consumer
 * (buildKnowledgeReferenceBlock, the message_sources insert, the
 * groundingMode check) needs no change beyond which selector answer.ts
 * calls.
 *
 *   Rule 1: vector_score >= vectorThreshold -> accepted.
 *     Exactly selectRelevantChunks' own behavior — a chunk that already
 *     clears the vector bar alone is untouched by anything lexical.
 *   Rule 2: vector_score >= vectorFloor AND lexical_score >= lexicalHigh
 *     -> accepted. A chunk vector search ranked only "reasonable" but
 *     whose lexical coverage is very strong (a real word-for-word match)
 *     is recovered — this is the entire point of the hybrid path.
 *   Rule 3 (implicit else): excluded — identical fallback behavior to
 *     today for anything neither rule accepts.
 *
 * Deliberately NOT a weighted average of the two scores — see the audit's
 * own reasoning: an average could let a middling result on both scores
 * pass by accident, which these explicit either/or rules cannot.
 *
 * A chunk with lexicalScore === undefined (retrieved via the legacy path,
 * see RetrievedChunk's own doc comment) is treated as lexicalScore 0 for
 * rule 2 — it can still be accepted by rule 1, never by rule 2 alone.
 */
export function selectHybridRelevantChunks(
  chunks: RetrievedChunk[],
  options: SelectHybridRelevantChunksOptions = {}
): RetrievedChunk[] {
  const vectorThreshold = options.vectorThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const vectorFloor = options.vectorFloor ?? HYBRID_VECTOR_FLOOR;
  const lexicalHigh = options.lexicalHigh ?? HYBRID_LEXICAL_HIGH;

  return chunks.filter((chunk) => {
    if (chunk.similarity >= vectorThreshold) return true; // Rule 1
    const lexicalScore = chunk.lexicalScore ?? 0;
    return chunk.similarity >= vectorFloor && lexicalScore >= lexicalHigh; // Rule 2
  });
}

/**
 * Bounds how many chunks a single dedicated accommodation page can inject
 * (see fetchAccommodationSourceChunks below) — a real, human-curated
 * "detail page" for one room/suite is naturally small (Le 1837's own
 * dedicated pages are 3 chunks each), but nothing stops a future source
 * from being large; this caps the worst case instead of assuming it away.
 */
export const MAX_DEDICATED_SOURCE_CHUNKS = 8;

export interface FetchAccommodationSourceChunksParams {
  hotelId: string;
  /** accommodation_types.source_url for the accommodation identified this turn — matched EXACTLY (never fuzzy) against knowledge_sources.source_url. */
  sourceUrl: string;
  supabase?: SupabaseClient;
}

/**
 * Guaranteed, bounded retrieval for a message that already names a KNOWN
 * accommodation (see accommodationRanking.ts:findMentionedAccommodation) —
 * additive to, never a replacement for, the normal hybrid retrieval above.
 * Exists because the normal path's own similarity threshold can reject a
 * chunk that is topically certain to be relevant simply because a query
 * like "la Deluxe a la climatisation ?" doesn't embed as closely to the
 * chunk's prose as its vector score would need — see this chantier's own
 * diagnostic (the two chunks containing "reversible air conditioning"
 * scored 0.44/0.45, both below the 0.5 threshold, while a near-empty
 * "Deluxe"-only fragment scored 0.54 and won by default). Bypassing
 * selectHybridRelevantChunks entirely for THIS specific, already-identified
 * source is deliberate: the accommodation match itself (a real name,
 * confirmed present in the message) is a stronger relevance signal than
 * any embedding score could add on top of it.
 *
 * accommodation_types.source_url and knowledge_sources.source_url are
 * guaranteed equal, by construction, for any row created through the
 * normal crawl-then-confirm flow (importCrawledPages + saveAccommodationTypes,
 * both in features/knowledge/actions.ts, write the SAME crawled page URL
 * into both tables) — an exact string match here is never a fuzzy guess.
 *
 * Returns [] (never throws to the caller — see answer.ts's own try/catch)
 * whenever: no source_url is known, no knowledge_source matches it exactly,
 * that source isn't active, or it has no chunks yet — every one of these is
 * a normal, expected state (a category can have a source_url before it's
 * ever been crawled/indexed), not an error condition on its own.
 */
export async function fetchAccommodationSourceChunks({
  hotelId,
  sourceUrl,
  supabase: injectedSupabase,
}: FetchAccommodationSourceChunksParams): Promise<RetrievedChunk[]> {
  const supabase = injectedSupabase ?? (await createClient());

  const { data: source } = await supabase
    .from("knowledge_sources")
    .select("id, title, source_url, last_synced_at")
    .eq("hotel_id", hotelId)
    .eq("source_url", sourceUrl)
    .eq("is_active", true)
    .maybeSingle();

  if (!source) return [];

  const { data: chunks } = await supabase
    .from("knowledge_chunks")
    .select("id, content")
    .eq("hotel_id", hotelId)
    .eq("source_id", source.id)
    .order("chunk_index", { ascending: true })
    .limit(MAX_DEDICATED_SOURCE_CHUNKS);

  if (!chunks || chunks.length === 0) return [];

  return chunks.map((chunk) => ({
    chunkId: chunk.id,
    sourceId: source.id,
    sourceTitle: source.title,
    content: chunk.content,
    // Guaranteed-relevant by scoping (a confirmed name match), not by
    // vector ranking — 1 reflects that confidence honestly for
    // message_sources.similarity_score (the only other reader of this
    // field), rather than a fabricated/misleading low score.
    similarity: 1,
    // Genuinely not computed for this path (no hybrid RPC call was made) —
    // undefined, not 0, matching RetrievedChunk's own documented meaning
    // for "not computed" vs. "computed as zero overlap". Unused downstream
    // anyway: these chunks never pass through selectHybridRelevantChunks.
    lexicalScore: undefined,
    sourceUrl: source.source_url,
    lastSyncedAt: source.last_synced_at,
  }));
}

/**
 * Merges chunks GUARANTEED relevant (fetchAccommodationSourceChunks) into
 * an already-selected/thresholded list — additive only: never removes
 * anything selectHybridRelevantChunks already accepted, deduplicates by
 * chunkId (a chunk that already cleared the normal threshold is never
 * listed twice), and places the guaranteed chunks FIRST — the most salient
 * position in the numbered reference block (see buildKnowledgeReferenceBlock),
 * so the model reads the confirmed-relevant, on-topic content before the
 * broader/noisier general retrieval results.
 */
export function mergeGuaranteedChunks(selected: RetrievedChunk[], guaranteed: RetrievedChunk[]): RetrievedChunk[] {
  if (guaranteed.length === 0) return selected;
  const seen = new Set(selected.map((c) => c.chunkId));
  const additional = guaranteed.filter((c) => !seen.has(c.chunkId));
  return [...additional, ...selected];
}
