import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getOpenAIClient } from "@/lib/openai/client";
import { openaiChatModel } from "@/lib/openai/env";
import { retrieveKnowledgeHybrid, selectHybridRelevantChunks } from "./retrieve";
import { buildHotelInstructions, buildKnowledgeReferenceBlock } from "./prompt";
import { extractPartySize, type PartySize } from "./partySize";
import { filterAndRankAccommodations, type AccommodationCandidate, type RankedCandidate } from "./accommodationRanking";
import { bookingCtaKind } from "./bookingCta";
import {
  ALL_PARTNERS_LIMIT,
  DEFAULT_PARTNER_LIMIT,
  detectRelevantPartnerCategory,
  isPartnerIntent,
  loadActiveHotelPartners,
  rankPartnerCandidates,
  toPartnerRecommendation,
  wantsAllPartners,
} from "./partners";
import { loadActiveHotelEvents, type ActiveHotelEvents } from "./events";
import { getSpaAvailability, type SpaAvailability } from "@/features/spa/booking";
import {
  isSpaBookingIntent,
  lastAssistantMessageContinuesSpaBooking,
  processSpaBookingTurn,
  resolveSpaBookingRequestFromHistory,
  validateSpaBookingRequestState,
  withSpaContinuationMarker,
  type SpaBookingModelOutput,
  type SpaBookingRequestState,
} from "./spaBookingFlow";
import { shouldResolveStayContext, isAvailabilityRequest } from "../availability/gates";
import { resolveStayRequestFromHistory } from "../availability/extractStayRequest";
import { validateStayRequestState } from "../availability/stayRequest";
import { checkAvailability } from "../availability/checkAvailability";
import { applyAvailabilityToCandidates } from "../availability/applyAvailabilityToCandidates";
import { NoopAvailabilityProviderResolver } from "../availability/resolver";
import type { AvailabilityCheckState, StayRequestState } from "../availability/types";
import type {
  AnswerQuestionResult,
  ChatAction,
  GroundingMode,
  PartnerRecommendation,
  PartnerRequestPhonePrompt,
  RagPartner,
  RetrievedChunk,
  RoomRecommendation,
  SpaBookingPhonePrompt,
} from "./types";
import type { AccommodationType, ChatbotSettings, Hotel } from "@/types/database";
import { redactPhoneNumbers } from "@/features/partnerRequests/phoneRedaction";
import { getActivePartnerRequestForConversation } from "@/features/partnerRequests/queries";
import type { PartnerRequest } from "@/features/partnerRequests/types";
import { processPartnerRequestTurn, type PartnerRequestModelOutput } from "./partnerRequestFlow";

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

/**
 * Price wording specifically — isAvailabilityRequest (availability/gates.ts)
 * deliberately covers reservation/availability wording only, since it also
 * gates the real checkAvailability() call and must stay narrow for that
 * purpose (see gates.ts's own doc comment). The CTA below needs a broader
 * net — "combien coûte une nuit ?" should trigger the booking CTA even
 * though it must never trigger an actual (nonexistent) price check.
 */
const PRICE_INTENT_PATTERNS: RegExp[] = [
  /\bprix\b/i,
  /\btarifs?\b/i,
  /combien\s+co[uû]te/i,
  /\bco[uû]te\b/i,
  /\bpayer\b/i,
  /\bprice\b/i,
  /\brates?\b/i,
  /\bcost\b/i,
];

/**
 * Broader than isAvailabilityRequest on purpose: reservation OR
 * availability OR price wording, all treated the same way by MODE STANDARD
 * — none of them can be answered for real, all of them should surface the
 * booking CTA when one is configured. Never used to gate the actual
 * checkAvailability() call (that stays exactly isAvailabilityRequest, see
 * above) — only to decide whether to attach a `action` to the result.
 */
export function isBookingIntent(message: string): boolean {
  return isAvailabilityRequest(message) || PRICE_INTENT_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The only place a ChatAction is ever constructed. Delegates the "which
 * kind" decision entirely to bookingCtaKind (features/rag/bookingCta.ts) —
 * the exact same decision prompt.ts's buildBookingIntentGuidance makes, so
 * the two can never disagree about what the hotel is actually configured
 * for. Never called with a "suppress" sentinel: a caller that wants to
 * suppress this action entirely (see answerGrounded's call site, which
 * skips calling this function outright when a RoomRecommendation already
 * covers the "url" case) does so by not calling it, not by falsifying the
 * hotel it passes in.
 */
export function buildBookingAction(
  bookingIntentDetected: boolean,
  hotel: Pick<Hotel, "booking_action_mode" | "booking_url" | "host_booking_trigger">
): ChatAction | null {
  if (!bookingIntentDetected) return null;
  const kind = bookingCtaKind(hotel);
  if (kind === "url") return { type: "booking", label: "Réserver", url: hotel.booking_url as string };
  if (kind === "host_widget") return { type: "host_booking", label: "Réserver" };
  return null;
}

export interface AnswerQuestionParams {
  hotelId: string;
  conversationId: string;
  message: string;
  /**
   * Injected Supabase client — defaults to the session-bound admin client
   * (createClient()), preserving today's behavior exactly for the admin
   * chat route. The public widget's chat route passes the service-role
   * client instead (see features/widget/publicHotel.ts): every table this
   * function touches (hotels, chatbot_settings, accommodation_types,
   * room_photos, messages, conversations, message_sources) has RLS scoped
   * to `is_superadmin()` plus an explicit `revoke all ... from anon`, so an
   * anonymous visitor's session-bound client can read/write none of them.
   * Tenant isolation for that path is therefore enforced entirely in
   * application code (widget_key -> hotelId resolved server-side, never
   * accepted from the client) rather than by RLS — see
   * features/widget/publicHotel.ts's resolvePublicWidgetContext.
   */
  supabase?: SupabaseClient;
}

/**
 * Minimal extension for the partner-REQUEST flow (distinct from
 * recommendedPartnerIds above, which only ever recommends — never books —
 * a partner) — shared by both branches, same "server decides, model only
 * proposes" discipline as every other field here: partnerId is revalidated
 * against loadActiveHotelPartners() before ever being trusted (see
 * partnerRequestFlow.ts), and none of these fields ever create/advance a
 * partner_request on their own — answerGrounded/answerNoContext do that
 * explicitly, after this parse, via processPartnerRequestTurn.
 *
 * Deliberately NEVER includes a phone number field: the model receives and
 * returns no phone-shaped data whatsoever (needsGuestPhone is a boolean
 * only) — see phoneRedaction.ts and partnerRequestFlow.ts, which resolve
 * the actual E.164 value entirely server-side, outside the model's view.
 */
const partnerRequestOutputFields = {
  partnerRequestIntent: z.boolean(),
  partnerId: z.string().nullable(),
  requestedDate: z.string().nullable(),
  requestedTime: z.string().nullable(),
  partySize: z.number().int().nullable(),
  details: z.string().nullable(),
  guestName: z.string().nullable(),
  needsGuestName: z.boolean(),
  needsGuestPhone: z.boolean(),
  confirmPartnerRequest: z.boolean(),
};

/**
 * Minimal extension for the spa-booking flow — see
 * features/rag/spaBookingFlow.ts's own SpaBookingModelOutput doc comment for
 * why bookingDate/slotStart/partySize are deliberately ABSENT here (they
 * come exclusively from a separate, validated extraction call, never the
 * main model's own structured output) and why the field names are distinct
 * from partnerRequestOutputFields's own guestName/needsGuestName/
 * needsGuestPhone despite serving an analogous role — both sets are spread
 * into the SAME schema below.
 */
const spaBookingOutputFields = {
  spaBookingIntent: z.boolean(),
  spaGuestName: z.string().nullable(),
  needsSpaGuestName: z.boolean(),
  needsSpaGuestPhone: z.boolean(),
  isNonResident: z.boolean(),
  notes: z.string().nullable(),
};

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
  /** Partner intent is orthogonal to groundingMode (see isPartnerIntent) — a no-context turn can still recommend a partner. Same "unverified until matched" discipline as the grounded schema's field. */
  recommendedPartnerIds: z.array(z.string()).nullable(),
  ...partnerRequestOutputFields,
  ...spaBookingOutputFields,
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
  /** Same "unverified until matched" discipline as recommendedAccommodationTypeId — see buildPartnerRecommendations below. */
  recommendedPartnerIds: z.array(z.string()).nullable(),
  ...partnerRequestOutputFields,
  ...spaBookingOutputFields,
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
export async function answerQuestion({
  hotelId,
  conversationId,
  message: rawMessage,
  supabase: injectedSupabase,
}: AnswerQuestionParams): Promise<AnswerQuestionResult> {
  const supabase = injectedSupabase ?? (await createClient());

  // MUST run before anything else touches the visitor's raw text: a
  // spontaneously-typed phone number must never reach messages.content or
  // the model. Every use of `message` below (persistence, retrieval query,
  // regex intent checks, model input) is the SANITIZED text — the raw
  // digits live only in `normalizedPhoneE164`, used later exclusively to
  // populate partner_requests.guest_phone_e164, never logged, never sent to
  // OpenAI. See features/partnerRequests/phoneRedaction.ts.
  const { sanitizedText: message, normalizedPhoneE164 } = redactPhoneNumbers(rawMessage);

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

  // hotel_id filtered in the query itself, not just implied by the caller
  // having already validated conversationId — auto-defensive even though
  // every caller (admin and public widget routes) already does that
  // validation before reaching this function.
  await supabase.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", conversationId).eq("hotel_id", hotelId);

  const history = await loadHistory(supabase, conversationId);
  const startedAt = Date.now();

  let relevantChunks: RetrievedChunk[];
  try {
    const chunks = await retrieveKnowledgeHybrid({ hotelId, query: message, limit: RETRIEVAL_LIMIT, supabase });
    relevantChunks = selectHybridRelevantChunks(chunks);
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

  // Computed once, independent of groundingMode and of
  // shouldResolveStayContext — a pure regex check on the raw message, cheap
  // enough to always run. Drives the generic booking CTA (see
  // buildBookingAction) in both branches below.
  const bookingIntentDetected = isBookingIntent(message);

  // Also orthogonal to groundingMode. Loading + ranking only runs when
  // intent was actually detected — no reason to query hotel_partners on
  // every single turn, most of which have nothing to do with a local
  // partner. The cap (DEFAULT_PARTNER_LIMIT, or ALL_PARTNERS_LIMIT on an
  // explicit "tous vos ..." request) is applied HERE, before the model ever
  // sees a candidate — see partners.ts's own doc comment on why that's
  // where "max 3 by default" is actually enforced, not left to the model.
  const partnerIntentDetected = isPartnerIntent(message);
  // The conversation's own in-progress request, if any — checked on EVERY
  // turn (not just when partnerIntentDetected fires) because a bare "oui"
  // confirming an already-prepared request would never match
  // isPartnerIntent's own keyword patterns on its own. See
  // features/partnerRequests/queries.ts's own doc comment.
  const activePartnerRequest = await getActivePartnerRequestForConversation(hotelId, conversationId, supabase);
  const partnerRequestFlowActive = partnerIntentDetected || activePartnerRequest !== null;

  let partnerCandidates: RagPartner[] = [];
  let allPartners: RagPartner[] = [];
  if (partnerRequestFlowActive) {
    allPartners = await loadActiveHotelPartners(supabase, hotelId);
    if (partnerIntentDetected) {
      const category = detectRelevantPartnerCategory(message);
      const limit = wantsAllPartners(message) ? ALL_PARTNERS_LIMIT : DEFAULT_PARTNER_LIMIT;
      partnerCandidates = rankPartnerCandidates(allPartners, { category, limit });
    }
  }

  // Orthogonal to groundingMode and to every intent-detection flag above —
  // unlike partners, hotel events have no keyword-based intent detector, so
  // this is loaded on EVERY turn (see prompt.ts's own doc comment on
  // BuildHotelInstructionsParams.events). loadActiveHotelEvents never
  // throws — a query failure here degrades to "no events this turn", never
  // fails the whole chat turn.
  const events = await loadActiveHotelEvents(supabase, hotelId, new Date().toISOString().slice(0, 10));

  // Spa booking: DB-backed partner state always outranks this heuristic
  // (see spaBookingFlow.ts's own header comment on why spa bookings carry
  // no persisted in-progress row) — a fresh message expressing both intents
  // at once also resolves to the partner flow, a documented, low-stakes
  // tie-break. lastAssistantMessageContinuesSpaBooking lets a keyword-free
  // reply ("2 personnes", a bare phone number) still be recognized as
  // continuing an active spa-booking collection.
  const todayIso = new Date().toISOString().slice(0, 10);
  const spaBookingFlowActive = !partnerRequestFlowActive && (isSpaBookingIntent(message) || lastAssistantMessageContinuesSpaBooking(historyInput));

  let spaAvailability: SpaAvailability = { enabled: false, date: todayIso, pricePerPerson: null, allowNonResidents: false, slots: [] };
  let resolvedSpaBookingRequest: SpaBookingRequestState = { bookingDate: null, slotStart: null, partySize: null };
  if (spaBookingFlowActive) {
    try {
      const rawSpaState = await resolveSpaBookingRequestFromHistory([...historyInput, { role: "user", content: message }], todayIso);
      resolvedSpaBookingRequest = validateSpaBookingRequestState(rawSpaState);
      spaAvailability = await getSpaAvailability(hotelId, resolvedSpaBookingRequest.bookingDate ?? todayIso, supabase);
    } catch (err) {
      // Best-effort enrichment — never fails the whole turn, same discipline
      // as the stay-request resolution block above. Both stay at their safe
      // fallback ("disabled"/all-null) values on failure.
      console.error("answerQuestion: spa booking resolution failed", { hotelId, message: (err as Error).message });
    }
  }

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
      bookingIntentDetected,
      partnerIntentDetected,
      partnerCandidates,
      normalizedPhoneE164,
      activePartnerRequest,
      partnerRequestFlowActive,
      allPartners,
      events,
      spaBookingFlowActive,
      spaAvailability,
      resolvedSpaBookingRequest,
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
    bookingIntentDetected,
    partnerIntentDetected,
    partnerCandidates,
    normalizedPhoneE164,
    activePartnerRequest,
    partnerRequestFlowActive,
    allPartners,
    events,
    spaBookingFlowActive,
    spaAvailability,
    resolvedSpaBookingRequest,
  });
}

/**
 * Best-effort, never fails the whole turn — same discipline as the
 * stay-request resolution block in answerQuestion above (its own try/catch,
 * swallowed and logged, safe fallback value). Appends
 * processPartnerRequestTurn's deterministic recap/confirmation text (see
 * partnerRequestFlow.ts) to the model's own conversational reply — never
 * replaces it, never lets a partner_request RPC failure surface as a
 * generic "OpenAI call failed" error to the caller.
 */
async function applyPartnerRequestFlow(
  reply: string,
  params: {
    hotelId: string;
    conversationId: string;
    message: string;
    normalizedPhoneE164: string | null;
    activePartnerRequest: PartnerRequest | null;
    allPartners: RagPartner[];
    modelOutput: PartnerRequestModelOutput;
  }
): Promise<{ reply: string; partnerRequestPhonePrompt: PartnerRequestPhonePrompt | null }> {
  try {
    const outcome = await processPartnerRequestTurn({
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      message: params.message,
      normalizedPhoneE164: params.normalizedPhoneE164,
      activePartnerRequest: params.activePartnerRequest,
      allActivePartners: params.allPartners,
      modelOutput: params.modelOutput,
    });
    return {
      reply: outcome.replySuffix ? (outcome.replaceReply ? outcome.replySuffix : `${reply}\n\n${outcome.replySuffix}`) : reply,
      partnerRequestPhonePrompt: outcome.phonePrompt,
    };
  } catch (err) {
    console.error("answerQuestion: partner request flow failed", { hotelId: params.hotelId, conversationId: params.conversationId, message: (err as Error).message });
    return { reply, partnerRequestPhonePrompt: null };
  }
}

/**
 * Mirrors applyPartnerRequestFlow above — same best-effort discipline (own
 * try/catch, never lets a spa-booking RPC failure surface as a generic
 * "OpenAI call failed" error). The ONE structural difference: whenever the
 * conversation is still mid-collection (outcome.continuesFlow), the
 * invisible continuation marker is appended to whatever reply text is about
 * to be persisted — this is the SOLE place that marker is ever written (see
 * spaBookingFlow.ts:withSpaContinuationMarker/lastAssistantMessageContinuesSpaBooking
 * for how a later turn recognizes it).
 */
async function applySpaBookingFlow(
  reply: string,
  params: {
    hotelId: string;
    conversationId: string;
    message: string;
    normalizedPhoneE164: string | null;
    availability: SpaAvailability;
    resolvedSpaBookingRequest: SpaBookingRequestState;
    modelOutput: SpaBookingModelOutput;
  }
): Promise<{ reply: string; spaBookingPhonePrompt: SpaBookingPhonePrompt | null }> {
  try {
    const outcome = await processSpaBookingTurn({
      hotelId: params.hotelId,
      conversationId: params.conversationId,
      message: params.message,
      normalizedPhoneE164: params.normalizedPhoneE164,
      availability: params.availability,
      resolvedRequest: params.resolvedSpaBookingRequest,
      modelOutput: params.modelOutput,
    });
    let nextReply = outcome.replySuffix ? (outcome.replaceReply ? outcome.replySuffix : `${reply}\n\n${outcome.replySuffix}`) : reply;
    if (outcome.continuesFlow) nextReply = withSpaContinuationMarker(nextReply);
    return { reply: nextReply, spaBookingPhonePrompt: outcome.phonePrompt };
  } catch (err) {
    console.error("answerQuestion: spa booking flow failed", { hotelId: params.hotelId, conversationId: params.conversationId, message: (err as Error).message });
    return { reply, spaBookingPhonePrompt: null };
  }
}

/**
 * The single point where raw model-provided partner ids become validated
 * PartnerRecommendations, or don't — mirrors buildRoomRecommendation's
 * discipline exactly. Requires each id to be present in partnerCandidates —
 * the exact, already-filtered-and-capped list offered THIS turn — never
 * merely "some hotel_partners row for this hotel_id". Since
 * partnerCandidates was already capped server-side (see answerQuestion),
 * the result can never exceed that cap either: the "max 3" rule is
 * structural, not just a prompt instruction the model might ignore.
 */
function buildPartnerRecommendations(recommendedPartnerIds: string[] | null, partnerCandidates: RagPartner[]): PartnerRecommendation[] {
  if (!recommendedPartnerIds || recommendedPartnerIds.length === 0) return [];
  const byId = new Map(partnerCandidates.map((partner) => [partner.id, partner]));
  const seen = new Set<string>();
  const result: PartnerRecommendation[] = [];
  for (const id of recommendedPartnerIds) {
    if (seen.has(id)) continue; // a model returning the same id twice must never produce a duplicate recommendation
    const partner = byId.get(id);
    if (!partner) continue; // unknown/stale/foreign id — silently dropped, never trusted
    seen.add(id);
    result.push(toPartnerRecommendation(partner));
  }
  return result;
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
    bookingIntentDetected: boolean;
    partnerIntentDetected: boolean;
    partnerCandidates: RagPartner[];
    normalizedPhoneE164: string | null;
    activePartnerRequest: PartnerRequest | null;
    partnerRequestFlowActive: boolean;
    allPartners: RagPartner[];
    events: ActiveHotelEvents;
    spaBookingFlowActive: boolean;
    spaAvailability: SpaAvailability;
    resolvedSpaBookingRequest: SpaBookingRequestState;
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
    bookingIntentDetected,
    partnerIntentDetected,
    partnerCandidates,
    normalizedPhoneE164,
    activePartnerRequest,
    partnerRequestFlowActive,
    allPartners,
    events,
    spaBookingFlowActive,
    spaAvailability,
    resolvedSpaBookingRequest,
  } = params;

  const instructions = buildHotelInstructions({
    hotel,
    settings,
    groundingMode: "grounded",
    rankedCandidates,
    party,
    availabilityCheckState,
    bookingIntentDetected,
    partnerIntentDetected,
    partnerCandidates,
    partnerRequestFlowActive,
    activePartnerRequest,
    allActivePartnersForRequest: allPartners,
    events,
    spaBookingFlowActive,
    spaAvailability,
    resolvedSpaBookingRequest,
  });
  const referenceBlock = buildKnowledgeReferenceBlock(relevantChunks);
  const input = [
    ...historyInput,
    { role: "user" as const, content: referenceBlock },
    { role: "user" as const, content: message },
  ];

  let reply: string;
  let recommendedAccommodationTypeId: string | null;
  let recommendedPartnerIds: string[] | null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let partnerRequestPhonePrompt: PartnerRequestPhonePrompt | null = null;
  let spaBookingPhonePrompt: SpaBookingPhonePrompt | null = null;

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
    recommendedPartnerIds = response.output_parsed.recommendedPartnerIds;
    inputTokens = response.usage?.input_tokens ?? null;
    outputTokens = response.usage?.output_tokens ?? null;

    // Mutually exclusive per turn — never both (see answerQuestion's own
    // spaBookingFlowActive computation, which is already false whenever
    // partnerRequestFlowActive is true).
    if (partnerRequestFlowActive) {
      const flowResult = await applyPartnerRequestFlow(reply, {
        hotelId,
        conversationId,
        message,
        normalizedPhoneE164,
        activePartnerRequest,
        allPartners,
        modelOutput: response.output_parsed,
      });
      reply = flowResult.reply;
      partnerRequestPhonePrompt = flowResult.partnerRequestPhonePrompt;
    } else if (spaBookingFlowActive) {
      const flowResult = await applySpaBookingFlow(reply, {
        hotelId,
        conversationId,
        message,
        normalizedPhoneE164,
        availability: spaAvailability,
        resolvedSpaBookingRequest,
        modelOutput: response.output_parsed,
      });
      reply = flowResult.reply;
      spaBookingPhonePrompt = flowResult.spaBookingPhonePrompt;
    }
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

  // A RoomRecommendation's own "Réserver" button already covers the
  // booking intent for this turn ONLY in the "url" case — RoomPhotoModal
  // shows that button exclusively when bookingUrl is truthy (see
  // RoomPhotoModal.tsx), which only ever happens for booking_action_mode =
  // "url". In "host_widget" mode a RoomRecommendation never renders a
  // button of its own, so the generic host_booking CTA must still be
  // offered — otherwise a visitor shown a room recommendation would have
  // no way to act on it at all.
  const hasDuplicateBookingLink = Boolean(roomRecommendation) && bookingCtaKind(hotel) === "url";
  const action = hasDuplicateBookingLink ? null : buildBookingAction(bookingIntentDetected, hotel);

  const partnerRecommendations = buildPartnerRecommendations(recommendedPartnerIds, partnerCandidates);

  return { reply, sources: relevantChunks, answerStatus: "answered", roomRecommendation, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt };
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
    bookingIntentDetected: boolean;
    partnerIntentDetected: boolean;
    partnerCandidates: RagPartner[];
    normalizedPhoneE164: string | null;
    activePartnerRequest: PartnerRequest | null;
    partnerRequestFlowActive: boolean;
    allPartners: RagPartner[];
    events: ActiveHotelEvents;
    spaBookingFlowActive: boolean;
    spaAvailability: SpaAvailability;
    resolvedSpaBookingRequest: SpaBookingRequestState;
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
    startedAt,
    availabilityCheckState,
    bookingIntentDetected,
    partnerIntentDetected,
    partnerCandidates,
    normalizedPhoneE164,
    activePartnerRequest,
    partnerRequestFlowActive,
    allPartners,
    events,
    spaBookingFlowActive,
    spaAvailability,
    resolvedSpaBookingRequest,
  } = params;

  const instructions = buildHotelInstructions({
    hotel,
    settings,
    groundingMode: "no_context",
    availabilityCheckState,
    bookingIntentDetected,
    partnerIntentDetected,
    partnerCandidates,
    partnerRequestFlowActive,
    activePartnerRequest,
    allActivePartnersForRequest: allPartners,
    events,
    spaBookingFlowActive,
    spaAvailability,
    resolvedSpaBookingRequest,
  });
  const input = [...historyInput, { role: "user" as const, content: message }];

  let reply: string;
  let answerStatus: "answered" | "fallback" | "handoff";
  let recommendedPartnerIds: string[] | null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let partnerRequestPhonePrompt: PartnerRequestPhonePrompt | null = null;
  let spaBookingPhonePrompt: SpaBookingPhonePrompt | null = null;

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
    recommendedPartnerIds = response.output_parsed.recommendedPartnerIds;
    inputTokens = response.usage?.input_tokens ?? null;
    outputTokens = response.usage?.output_tokens ?? null;

    if (partnerRequestFlowActive) {
      const flowResult = await applyPartnerRequestFlow(reply, {
        hotelId,
        conversationId,
        message,
        normalizedPhoneE164,
        activePartnerRequest,
        allPartners,
        modelOutput: response.output_parsed,
      });
      reply = flowResult.reply;
      partnerRequestPhonePrompt = flowResult.partnerRequestPhonePrompt;
    } else if (spaBookingFlowActive) {
      const flowResult = await applySpaBookingFlow(reply, {
        hotelId,
        conversationId,
        message,
        normalizedPhoneE164,
        availability: spaAvailability,
        resolvedSpaBookingRequest,
        modelOutput: response.output_parsed,
      });
      reply = flowResult.reply;
      spaBookingPhonePrompt = flowResult.spaBookingPhonePrompt;
    }
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

  // no_context never produces a RoomRecommendation (see answer.groundingMode.test.ts) — nothing to deduplicate against, unlike answerGrounded.
  const action = buildBookingAction(bookingIntentDetected, hotel);

  const partnerRecommendations = buildPartnerRecommendations(recommendedPartnerIds, partnerCandidates);

  return { reply, sources: [], answerStatus, roomRecommendation: null, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt };
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
  return { reply, sources: [], answerStatus: "error", roomRecommendation: null, action: null, partnerRecommendations: [], partnerRequestPhonePrompt: null, spaBookingPhonePrompt: null };
}
