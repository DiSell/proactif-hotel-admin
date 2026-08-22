import { getOpenAIClient } from "@/lib/openai/client";
import { EMBEDDING_DIMENSIONS, openaiEmbeddingModel } from "@/lib/openai/env";

export interface EmbedManyResult {
  vectors: number[][];
  totalTokens: number | null;
}

/**
 * Embeds one or more texts. Always requests EMBEDDING_DIMENSIONS explicitly
 * for text-embedding-3-* models (they support truncating their native
 * output down via the `dimensions` param — this is what keeps the
 * `vector(1536)` column compatible regardless of whether
 * OPENAI_EMBEDDING_MODEL is the small or large 3-series model). Older
 * models (e.g. text-embedding-ada-002) don't support that param at all, so
 * for those we skip it and instead verify the returned length after the
 * fact — either way, a mismatch throws a clear, explicit error rather than
 * silently handing Postgres a wrongly-sized vector.
 */
export async function embedMany(texts: string[]): Promise<EmbedManyResult> {
  if (texts.length === 0) {
    return { vectors: [], totalTokens: 0 };
  }

  const client = getOpenAIClient();
  const model = openaiEmbeddingModel();
  const supportsDimensionsParam = model.startsWith("text-embedding-3");

  const response = await client.embeddings.create({
    input: texts,
    model,
    ...(supportsDimensionsParam ? { dimensions: EMBEDDING_DIMENSIONS } : {}),
  });

  const vectors = [...response.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);

  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `OPENAI_EMBEDDING_MODEL "${model}" returned a ${vector.length}-dimensional embedding, but the database column is vector(${EMBEDDING_DIMENSIONS}). Configure a model compatible with ${EMBEDDING_DIMENSIONS} dimensions (e.g. text-embedding-3-small), or add a new migration if you intend to change the column size.`
      );
    }
  }

  return { vectors, totalTokens: response.usage?.total_tokens ?? null };
}

export async function embedText(text: string): Promise<number[]> {
  const { vectors } = await embedMany([text]);
  return vectors[0];
}
