import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { chunkText } from "./chunk";
import { embedMany } from "./embeddings";
import type { KnowledgeSource } from "@/types/database";

export interface IngestResult {
  ok: boolean;
  chunkCount?: number;
  error?: string;
}

const NO_CONTENT_MESSAGE = "Contenu de la page non disponible. Analyse du site à implémenter.";

/**
 * (Re)indexes one knowledge_sources row: builds its text depending on
 * type, chunks it, embeds every chunk, and atomically swaps the old chunks
 * for the new ones via replace_knowledge_chunks() — only after every
 * embedding has succeeded, so a failed OpenAI call never leaves the source
 * half-reindexed. Sets knowledge_sources.status to 'indexed' only on full
 * success, 'error' on any failure (never silently "indexed" without real
 * chunks behind it).
 */
export async function ingestSource(hotelId: string, sourceId: string): Promise<IngestResult> {
  await requireSuperadmin();
  const supabase = await createClient();

  const { data: source, error: fetchError } = await supabase
    .from("knowledge_sources")
    .select("*")
    .eq("id", sourceId)
    .eq("hotel_id", hotelId)
    .maybeSingle<KnowledgeSource>();

  if (fetchError || !source) {
    return { ok: false, error: "Source introuvable." };
  }

  const text = buildSourceText(source);
  if (text === null) {
    await markError(supabase, sourceId);
    return { ok: false, error: NO_CONTENT_MESSAGE };
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    await markError(supabase, sourceId);
    return { ok: false, error: "Aucun contenu exploitable dans cette source." };
  }

  let vectors: number[][];
  try {
    const result = await embedMany(chunks.map((c) => c.content));
    vectors = result.vectors;
  } catch (err) {
    console.error("ingestSource: embedding failed", { sourceId, hotelId, message: (err as Error).message });
    await markError(supabase, sourceId);
    return { ok: false, error: "Impossible de générer les embeddings pour cette source." };
  }

  const payload = chunks.map((chunk, index) => ({
    content: chunk.content,
    embedding: vectors[index],
    chunk_index: chunk.chunkIndex,
    token_count: chunk.tokenCount,
    metadata: chunk.metadata,
  }));

  const { error: replaceError } = await supabase.rpc("replace_knowledge_chunks", {
    p_source_id: sourceId,
    p_hotel_id: hotelId,
    p_chunks: payload,
  });

  if (replaceError) {
    console.error("ingestSource: replace_knowledge_chunks failed", {
      sourceId,
      hotelId,
      message: replaceError.message,
    });
    await markError(supabase, sourceId);
    return { ok: false, error: "Impossible d’enregistrer les connaissances indexées." };
  }

  await supabase
    .from("knowledge_sources")
    .update({ status: "indexed", last_synced_at: new Date().toISOString() })
    .eq("id", sourceId);

  return { ok: true, chunkCount: chunks.length };
}

function buildSourceText(source: KnowledgeSource): string | null {
  switch (source.type) {
    case "text":
    case "internal_note":
      return source.content?.trim() || null;
    case "faq":
      if (!source.content?.trim()) return null;
      return `Question:\n${source.title}\n\nRéponse:\n${source.content.trim()}`;
    case "url":
    case "document":
      // No crawler / document extraction yet this milestone — index the
      // stored content if it exists, never fabricate it if it doesn't.
      return source.content?.trim() || null;
    default:
      return null;
  }
}

async function markError(supabase: Awaited<ReturnType<typeof createClient>>, sourceId: string) {
  await supabase.from("knowledge_sources").update({ status: "error" }).eq("id", sourceId);
}
