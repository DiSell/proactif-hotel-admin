import { createClient } from "@/lib/supabase/server";
import { getOpenAIClient } from "@/lib/openai/client";
import { openaiChatModel } from "@/lib/openai/env";
import { retrieveKnowledge, selectRelevantChunks, DEFAULT_SIMILARITY_THRESHOLD } from "./retrieve";
import { buildHotelInstructions, buildKnowledgeReferenceBlock } from "./prompt";
import type { AnswerQuestionResult } from "./types";
import type { ChatbotSettings, Hotel } from "@/types/database";

/** How much prior conversation gets replayed to the model — never the full history. */
const MAX_HISTORY_MESSAGES = 12;
const RETRIEVAL_LIMIT = 6;

const GENERIC_ERROR_REPLY = "Une erreur est survenue. Veuillez réessayer dans un instant.";
const DEFAULT_FALLBACK_REPLY =
  "Je ne dispose pas de cette information pour le moment. Un membre de l'équipe reviendra vers vous.";

export interface AnswerQuestionParams {
  hotelId: string;
  conversationId: string;
  message: string;
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Orchestrates one turn: persists the visitor's message, retrieves
 * tenant-scoped knowledge, decides fallback vs. answered, calls OpenAI only
 * when there's something relevant to ground the answer in, persists the
 * assistant's reply + which chunks (if any) backed it, and returns the
 * result. Never lets the model answer ungrounded — see the fallback branch.
 */
export async function answerQuestion({ hotelId, conversationId, message }: AnswerQuestionParams): Promise<AnswerQuestionResult> {
  const supabase = await createClient();

  const { data: hotel, error: hotelError } = await supabase
    .from("hotels")
    .select("*")
    .eq("id", hotelId)
    .maybeSingle<Hotel>();
  if (hotelError || !hotel) {
    throw new Error("answerQuestion: hotel not found");
  }

  const { data: settings } = await supabase
    .from("chatbot_settings")
    .select("*")
    .eq("hotel_id", hotelId)
    .maybeSingle<ChatbotSettings>();

  const { error: userMessageError } = await supabase
    .from("messages")
    .insert({ hotel_id: hotelId, conversation_id: conversationId, role: "user", content: message });
  if (userMessageError) {
    throw new Error(`answerQuestion: failed to store user message: ${userMessageError.message}`);
  }

  await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId);

  const history = await loadHistory(supabase, conversationId);
  const startedAt = Date.now();

  let relevantChunks;
  try {
    const chunks = await retrieveKnowledge({ hotelId, query: message, limit: RETRIEVAL_LIMIT });
    relevantChunks = selectRelevantChunks(chunks, DEFAULT_SIMILARITY_THRESHOLD);
  } catch (err) {
    console.error("answerQuestion: retrieval failed", { hotelId, message: (err as Error).message });
    return finalizeError(supabase, hotelId, conversationId, settings, Date.now() - startedAt);
  }

  if (relevantChunks.length === 0) {
    const reply = settings?.fallback_message?.trim() || DEFAULT_FALLBACK_REPLY;
    await insertAssistantMessage(supabase, {
      hotelId,
      conversationId,
      content: reply,
      answerStatus: "fallback",
      model: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - startedAt,
    });
    return { reply, sources: [], answerStatus: "fallback" };
  }

  const instructions = buildHotelInstructions({ hotel, settings });
  // The retrieved knowledge is data, not an instruction: it goes in `input`
  // as its own item, clearly separated from the visitor's actual message,
  // never concatenated into `instructions` (see prompt.ts). At this point
  // relevantChunks is always non-empty — the fallback branch above already
  // returned when there was nothing relevant.
  const referenceBlock = buildKnowledgeReferenceBlock(relevantChunks);
  const input = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: referenceBlock },
    { role: "user" as const, content: message },
  ];

  const model = openaiChatModel();
  let reply: string;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  try {
    const client = getOpenAIClient();
    const response = await client.responses.create({ model, instructions, input });
    reply = response.output_text;
    inputTokens = response.usage?.input_tokens ?? null;
    outputTokens = response.usage?.output_tokens ?? null;
  } catch (err) {
    console.error("answerQuestion: OpenAI call failed", { hotelId, message: (err as Error).message });
    return finalizeError(supabase, hotelId, conversationId, settings, Date.now() - startedAt);
  }

  const latencyMs = Date.now() - startedAt;

  const { data: assistantMessage } = await insertAssistantMessage(supabase, {
    hotelId,
    conversationId,
    content: reply,
    answerStatus: "answered",
    model,
    inputTokens,
    outputTokens,
    latencyMs,
  });

  if (assistantMessage) {
    const sourceRows = relevantChunks.map((chunk) => ({
      message_id: assistantMessage.id,
      hotel_id: hotelId,
      source_id: chunk.sourceId,
      chunk_id: chunk.chunkId,
      similarity_score: chunk.similarity,
    }));
    const { error: sourcesError } = await supabase.from("message_sources").insert(sourceRows);
    if (sourcesError) {
      console.error("answerQuestion: failed to store message_sources", { hotelId, message: sourcesError.message });
    }
  }

  return { reply, sources: relevantChunks, answerStatus: "answered" };
}

async function loadHistory(supabase: SupabaseClient, conversationId: string) {
  const { data } = await supabase
    .from("messages")
    .select("role, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);
  return (data ?? []).reverse();
}

async function insertAssistantMessage(
  supabase: SupabaseClient,
  params: {
    hotelId: string;
    conversationId: string;
    content: string;
    answerStatus: AnswerQuestionResult["answerStatus"];
    model: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  }
) {
  return supabase
    .from("messages")
    .insert({
      hotel_id: params.hotelId,
      conversation_id: params.conversationId,
      role: "assistant",
      content: params.content,
      answer_status: params.answerStatus,
      model: params.model,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      latency_ms: params.latencyMs,
    })
    .select("id")
    .single();
}

async function finalizeError(
  supabase: SupabaseClient,
  hotelId: string,
  conversationId: string,
  settings: ChatbotSettings | null | undefined,
  latencyMs: number
): Promise<AnswerQuestionResult> {
  const reply = settings?.fallback_message?.trim() || GENERIC_ERROR_REPLY;
  await insertAssistantMessage(supabase, {
    hotelId,
    conversationId,
    content: reply,
    answerStatus: "error",
    model: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs,
  });
  return { reply, sources: [], answerStatus: "error" };
}
