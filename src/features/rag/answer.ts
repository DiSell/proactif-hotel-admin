import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { createClient } from "@/lib/supabase/server";
import { getOpenAIClient } from "@/lib/openai/client";
import { openaiChatModel } from "@/lib/openai/env";
import { retrieveKnowledge, selectRelevantChunks, DEFAULT_SIMILARITY_THRESHOLD } from "./retrieve";
import { buildHotelInstructions, buildKnowledgeReferenceBlock } from "./prompt";
import { extractPartySize, type PartySize } from "./partySize";
import { filterAndRankAccommodations, type AccommodationCandidate, type RankedCandidate } from "./accommodationRanking";
import { shouldResolveStayContext, isAvailabilityRequest } from "../availability/gates";
import { resolveStayRequestFromHistory } from "../availability/extractStayRequest";
import { validateStayRequestState } from "../availability/stayRequest";
import { checkAvailability } from "../availability/checkAvailability";
import { applyAvailabilityToCandidates } from "../availability/applyAvailabilityToCandidates";
import { NoopAvailabilityProviderResolver } from "../availability/resolver";
import type { AvailabilityCheckState, StayRequestState } from "../availability/types";
import type { AnswerQuestionResult, GroundingMode, RetrievedChunk, RoomRecommendation } from "./types";
import type { AccommodationType, ChatbotSettings, Hotel } from "@/types/database";

/**
 * Phase A: no hotel-configured timezone field exists yet (see
 * src/types/database.ts Hotel) — no migration is added just for this. UTC
 * is an honest, assumption-free placeholder rather than guessing a
 * business timezone; revisit once a real field exists.
 */
const FALLBACK_TIME_ZONE = "UTC";

/** A single resolver instance for the whole process — Phase A always resolves to no_provider, cheaply, so nothing needs per-call construction. */
const availabilityProviderResolver = new NoopAvailabilityProviderResolver();

/** How much prior conversation gets replayed to the model — never the full history. */
const MAX_HISTORY_MESSAGES = 12;
const RETRIEVAL_LIMIT = 6;

const GENERIC_ERROR_REPLY = "Une erreur est survenue. Veuillez réessayer dans un instant.";

export interface AnswerQuestionParams {
  hotelId: string;
  conversationId: string;
  message: string;
}

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

/**
 * Structured output schema for the "no_context" branch only. Without a
 * chunk count to infer answerStatus from, the model itself has to say
 * whether this turn was a valid behavioral answer, an unsourced factual
 * question, or something needing human handoff — see buildNoContextGuidance
 * in prompt.ts for the criteria it's given. The "grounded" branch doesn't
 * need this: finding relevant chunks is itself enough to call it "answered".
 */
const noContextReplySchema = z.object({
  reply: z.string(),
  answerStatus: z.enum(["answered", "fallback", "handoff"]),
});

/**
 * Structured output schema for the "grounded" branch. recommendedAccommodationTypeId
 * is a raw, UNVERIFIED string from the model at this point — answerGrounded
 * validates it against the exact rankedCandidates list actually offered
 * this turn before it's ever trusted (see buildRoomRecommendation below).
 * Never null-coalesced into a real recommendation without that check.
 */
const groundedReplySchema = z.object({
  reply: z.string(),
  recommendedAccommodationTypeId: z.string().nullable(),
});

/**
 * Orchestrates one turn: persists the visitor's message, retrieves
 * tenant-scoped knowledge, and always calls the model — either GROUNDED
 * (relevant chunks found, passed as reference data) or NO_CONTEXT (nothing
 * relevant found, no knowledge block, model self-classifies answerStatus).
 * The model is never short-circuited to a static reply just because
 * retrieval came back empty — see groundingMode below. It's still never
 * allowed to invent an operational fact about the establishment: that
 * guarantee now lives in the prompt's absolute rules + capabilities section
 * (prompt.ts) instead of in a pre-model gate here.
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

  let relevantChunks: RetrievedChunk[];
  try {
    const chunks = await retrieveKnowledge({ hotelId, query: message, limit: RETRIEVAL_LIMIT });
    relevantChunks = selectRelevantChunks(chunks, DEFAULT_SIMILARITY_THRESHOLD);
  } catch (err) {
    console.error("answerQuestion: retrieval failed", { hotelId, message: (err as Error).message });
    return finalizeError(supabase, hotelId, conversationId, settings, Date.now() - startedAt);
  }

  const groundingMode: GroundingMode = relevantChunks.length > 0 ? "grounded" : "no_context";
  const model = openaiChatModel();
  const historyInput = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Independent of groundingMode, deliberately (see prompt.ts's
  // buildAvailabilityGuidance and the plan): a stay/availability question
  // must be resolvable even when RAG finds no relevant chunk at all — RAG
  // and availability are orthogonal concerns, never gating one another.
  const { data: accommodationTypes } = await supabase
    .from("accommodation_types")
    .select("*")
    .eq("hotel_id", hotelId)
    .eq("active", true)
    .returns<AccommodationType[]>();
  const accommodationTypesById = new Map((accommodationTypes ?? []).map((a) => [a.id, a]));
  const candidates: AccommodationCandidate[] = (accommodationTypes ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    maxGuests: a.max_guests,
    maxAdults: a.max_adults,
    maxChildren: a.max_children,
  }));

  // Cheap fallback, always available: a single-message regex extraction —
  // unchanged from before this chantier. Only upgraded to the richer
  // multi-turn state below when the broad gate judges it worth the cost of
  // an extra model call.
  let party: PartySize = extractPartySize(message);
  let availabilityCheckState: AvailabilityCheckState = { kind: "not_requested" };

  if (shouldResolveStayContext(message)) {
    try {
      const rawState = await resolveStayRequestFromHistory([...historyInput, { role: "user", content: message }], {
        referenceDate: new Date().toISOString().slice(0, 10),
        timeZone: FALLBACK_TIME_ZONE,
      });
      const validatedState: StayRequestState = validateStayRequestState(rawState);

      if (validatedState.adults !== null && validatedState.childrenCount !== null) {
        party = { adults: validatedState.adults, children: validatedState.childrenCount, total: validatedState.adults + validatedState.childrenCount };
      }

      // isAvailabilityRequest, not shouldResolveStayContext, gates the
      // actual provider call — see gates.ts: a business-only capacity
      // question must never produce a spurious "can't check availability" aside.
      if (isAvailabilityRequest(message)) {
        availabilityCheckState = await checkAvailability({ hotelId, state: validatedState, resolver: availabilityProviderResolver });
      }
    } catch (err) {
      // Best-effort enrichment — never fails the whole turn. party/availabilityCheckState stay at their safe fallback values.
      console.error("answerQuestion: stay-request resolution failed", { hotelId, message: (err as Error).message });
    }
  }

  let rankedCandidates = filterAndRankAccommodations(candidates, party);
  // Server-side enforcement, not just prompt guidance (see
  // applyAvailabilityToCandidates): a capacity-compatible candidate the
  // provider reports UNAVAILABLE/UNKNOWN can never be offered as a
  // confirmed-available recommendation. A no-op when no check ran.
  rankedCandidates = applyAvailabilityToCandidates(rankedCandidates, availabilityCheckState);

  if (groundingMode === "grounded") {
    return answerGrounded(supabase, {
      hotelId,
      conversationId,
      message,
      hotel,
      settings,
      model,
      historyInput,
      relevantChunks,
      startedAt,
      rankedCandidates,
      party,
      accommodationTypesById,
      availabilityCheckState,
    });
  }

  return answerNoContext(supabase, {
    hotelId,
    conversationId,
    message,
    hotel,
    settings,
    model,
    historyInput,
    startedAt,
    availabilityCheckState,
  });
}

type HistoryInputItem = { role: "user" | "assistant"; content: string };

/**
 * The single point where a raw model-provided id becomes a real
 * recommendation, or doesn't. Requires the id to be present in
 * rankedCandidates — the exact, already-filtered list offered THIS turn —
 * not merely "some accommodation_types row for this hotel_id" (a candidate
 * the capacity filter already excluded must never come back through this
 * path). Any mismatch, including a stale/foreign id, resolves to null.
 */
async function buildRoomRecommendation(
  supabase: SupabaseClient,
  params: {
    hotelId: string;
    recommendedAccommodationTypeId: string | null;
    rankedCandidates: RankedCandidate[];
    accommodationTypesById: Map<string, AccommodationType>;
    /** hotels.booking_url, passed straight through from the already-loaded hotel row — see answerGrounded's call site. Never sourced from the model or the visitor's message. */
    bookingUrl: string | null;
  }
): Promise<RoomRecommendation | null> {
  const { hotelId, recommendedAccommodationTypeId, rankedCandidates, accommodationTypesById, bookingUrl } = params;
  if (!recommendedAccommodationTypeId) return null;

  const matched = rankedCandidates.find((c) => c.id === recommendedAccommodationTypeId);
  if (!matched) return null;

  const accommodationType = accommodationTypesById.get(matched.id);
  if (!accommodationType || accommodationType.hotel_id !== hotelId) return null;

  const { data: photos } = await supabase
    .from("room_photos")
    .select("photo_url, alt_text")
    .eq("hotel_id", hotelId)
    .eq("accommodation_type_id", matched.id)
    .order("position", { ascending: true });

  return {
    accommodationTypeId: matched.id,
    name: matched.name,
    photos: (photos ?? []).map((p) => ({ url: p.photo_url as string, alt: p.alt_text as string | null })),
    pageUrl: accommodationType.source_url,
    bookingUrl,
  };
}

/**
 * GROUNDED: relevant knowledge chunks were found — pass them as reference
 * data in `input` (never in `instructions`, see prompt.ts) and let the model
 * ground its answer in them. Always "answered": finding relevant chunks is
 * itself the signal, so there's no self-classification needed here (unlike
 * answerNoContext below).
 *
 * Uses structured output (responses.parse + groundedReplySchema) so the
 * model can additionally name an accommodation it's recommending — but only
 * from rankedCandidates, a list ALREADY filtered by capacity server-side
 * (see answerQuestion/accommodationRanking.ts). recommendedAccommodationTypeId
 * coming back from the model is still just a string at that point: it's
 * only trusted once matched against rankedCandidates by id below — an id
 * for a different hotel, an id that was never offered, or an id that was
 * already excluded by the capacity filter all resolve to no recommendation
 * at all, never a fabricated one.
 */
async function answerGrounded(
  supabase: SupabaseClient,
  params: {
    hotelId: string;
    conversationId: string;
    message: string;
    hotel: Hotel;
    settings: ChatbotSettings | null;
    model: string;
    historyInput: HistoryInputItem[];
    relevantChunks: RetrievedChunk[];
    startedAt: number;
    rankedCandidates: RankedCandidate[];
    party: PartySize;
    accommodationTypesById: Map<string, AccommodationType>;
    availabilityCheckState: AvailabilityCheckState;
  }
): Promise<AnswerQuestionResult> {
  const {
    hotelId,
    conversationId,
    message,
    hotel,
    settings,
    model,
    historyInput,
    relevantChunks,
    startedAt,
    rankedCandidates,
    party,
    accommodationTypesById,
    availabilityCheckState,
  } = params;

  const instructions = buildHotelInstructions({ hotel, settings, groundingMode: "grounded", rankedCandidates, party, availabilityCheckState });
  const referenceBlock = buildKnowledgeReferenceBlock(relevantChunks);
  const input = [
    ...historyInput,
    { role: "user" as const, content: referenceBlock },
    { role: "user" as const, content: message },
  ];

  let reply: string;
  let recommendedAccommodationTypeId: string | null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  try {
    const client = getOpenAIClient();
    const response = await client.responses.parse({
      model,
      instructions,
      input,
      text: { format: zodTextFormat(groundedReplySchema, "assistant_reply") },
    });
    if (!response.output_parsed) {
      throw new Error("grounded response did not match the expected structured schema");
    }
    reply = response.output_parsed.reply;
    recommendedAccommodationTypeId = response.output_parsed.recommendedAccommodationTypeId;
    inputTokens = response.usage?.input_tokens ?? null;
    outputTokens = response.usage?.output_tokens ?? null;
  } catch (err) {
    console.error("answerQuestion: OpenAI call failed (grounded)", { hotelId, message: (err as Error).message });
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

  const roomRecommendation = await buildRoomRecommendation(supabase, {
    hotelId,
    recommendedAccommodationTypeId,
    rankedCandidates,
    accommodationTypesById,
    bookingUrl: hotel.booking_url,
  });

  return { reply, sources: relevantChunks, answerStatus: "answered", roomRecommendation };
}

/**
 * NO_CONTEXT: nothing relevant was retrieved. The model still runs — no
 * knowledge block in `input`, instructions carry buildNoContextGuidance's
 * boundary (identity/settings/capabilities/real contact info only, never
 * invent an operational fact) — and self-classifies answerStatus via
 * structured output, since an empty chunk list is no longer a reliable
 * signal on its own (a greeting and an unsourced price question both have
 * zero chunks, but very different correct answerStatus).
 */
async function answerNoContext(
  supabase: SupabaseClient,
  params: {
    hotelId: string;
    conversationId: string;
    message: string;
    hotel: Hotel;
    settings: ChatbotSettings | null;
    model: string;
    historyInput: HistoryInputItem[];
    startedAt: number;
    availabilityCheckState: AvailabilityCheckState;
  }
): Promise<AnswerQuestionResult> {
  const { hotelId, conversationId, message, hotel, settings, model, historyInput, startedAt, availabilityCheckState } = params;

  const instructions = buildHotelInstructions({ hotel, settings, groundingMode: "no_context", availabilityCheckState });
  const input = [...historyInput, { role: "user" as const, content: message }];

  let reply: string;
  let answerStatus: "answered" | "fallback" | "handoff";
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;

  try {
    const client = getOpenAIClient();
    const response = await client.responses.parse({
      model,
      instructions,
      input,
      text: { format: zodTextFormat(noContextReplySchema, "assistant_reply") },
    });
    if (!response.output_parsed) {
      throw new Error("no_context response did not match the expected structured schema");
    }
    reply = response.output_parsed.reply;
    answerStatus = response.output_parsed.answerStatus;
    inputTokens = response.usage?.input_tokens ?? null;
    outputTokens = response.usage?.output_tokens ?? null;
  } catch (err) {
    console.error("answerQuestion: OpenAI call failed (no_context)", { hotelId, message: (err as Error).message });
    return finalizeError(supabase, hotelId, conversationId, settings, Date.now() - startedAt);
  }

  const latencyMs = Date.now() - startedAt;

  await insertAssistantMessage(supabase, {
    hotelId,
    conversationId,
    content: reply,
    answerStatus,
    model,
    inputTokens,
    outputTokens,
    latencyMs,
  });

  return { reply, sources: [], answerStatus, roomRecommendation: null };
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
  return { reply, sources: [], answerStatus: "error", roomRecommendation: null };
}
