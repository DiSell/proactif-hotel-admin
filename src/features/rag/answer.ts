import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getOpenAIClient } from "@/lib/openai/client";
import { openaiChatModel } from "@/lib/openai/env";
import { fetchAccommodationSourceChunks, mergeGuaranteedChunks, retrieveKnowledgeHybrid, selectHybridRelevantChunks } from "./retrieve";
import { buildHotelInstructions, buildKnowledgeReferenceBlock } from "./prompt";
import { extractPartySize, extractPartySizeFromHistory, isPartyKnown, mergeValidatedStayRequestIntoParty, type PartySize } from "./partySize";
import {
  filterAndRankAccommodations,
  findMentionedAccommodation,
  isRoomDiscoveryIntent,
  shouldAskPartySizeOnly,
  type AccommodationCandidate,
  type RankedCandidate,
} from "./accommodationRanking";
import { bookingCtaKind } from "./bookingCta";
import { lastAssistantMessageIndicatesBookingIntent, withBookingIntentMarker } from "./bookingIntentContinuation";
import { lastAssistantMessageIndicatesRoomDiscoveryContinuation, withRoomDiscoveryMarker } from "./roomDiscoveryContinuation";
import { containsUnauthorizedMonetaryAmount, isPriceCommunicationAllowed, redactMonetaryAmounts, PRICE_LOCKED_FALLBACK_REPLY } from "./pricePolicy";
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
import { flagConversationForModeration } from "./moderation";
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
  RoomCatalogueEntry,
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
/**
 * A hotel's rooms are a closed, enumerable set (rarely more than a handful
 * of distinct types) — unlike an open-ended factual question, "which rooms
 * do you have?" has a WRONG answer the moment even one real room type is
 * left out. For a hotel with no structured accommodation_types data (see
 * answer.ts's own accommodationTypes query below — several real hotels ship
 * with this table empty), room descriptions live ONLY as scraped knowledge
 * chunks, often split by the crawler into several overlapping/redundant
 * fragments per room (observed directly: one real hotel's site produced 4-7
 * chunks for a single room type across its 54 total chunks). The default
 * RETRIEVAL_LIMIT (6) was silently dropping some room types from the answer
 * — confirmed live: "Deluxe" and "Standard" both had full descriptions in
 * knowledge_chunks, neither made the cut for a stay/party-size question that
 * mentioned six OTHER room-relevant fragments instead. Raised specifically
 * (not globally) for any turn shouldResolveStayContext already flags as
 * about rooms/stay/party size (gates.ts) — the same broad, cheap-false-
 * positive-tolerant signal already computed for stay-context resolution
 * below, reused here instead of adding a second detector. selectHybridRelevantChunks'
 * own relevance thresholds still apply afterward — this only widens the
 * CANDIDATE pool considered before that filter, it never forces in an
 * actually-irrelevant chunk.
 */
const ACCOMMODATION_RETRIEVAL_LIMIT = 24;

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
 * Orthogonal to every other flow above — the model self-reports whether the
 * VISITOR'S CURRENT message itself is abusive (insult, hateful content,
 * harassment, jailbreak attempt), per the absolute rules in prompt.ts. Never
 * gated by partner/spa intent: checked and acted upon (see
 * applyModerationFlag below) after every single model call, in both
 * answerGrounded and answerNoContext. flagReason is a short, neutral,
 * staff-facing description — the model is instructed to never repeat the
 * actual slur/insult text into it (see prompt.ts).
 */
const moderationOutputFields = {
  flaggedAsAbusive: z.boolean(),
  flagReason: z.string().nullable(),
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
  ...moderationOutputFields,
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
  ...moderationOutputFields,
});

/**
 * Best-effort, never fails the turn — flagConversationForModeration
 * (moderation.ts) already swallows and logs every error itself, and is
 * idempotent (at most one notification per conversation). Awaited, not
 * fire-and-forget: a serverless request handler can be torn down as soon as
 * its response is sent, which would silently drop an un-awaited RPC/email
 * call. A defensive fallback reason covers the case where the model reports
 * flaggedAsAbusive without a flagReason, so flag_conversation() never
 * receives a null reason on the very first flag.
 */
async function applyModerationFlag(hotelId: string, conversationId: string, modelOutput: { flaggedAsAbusive: boolean; flagReason: string | null }, supabase: SupabaseClient): Promise<void> {
  if (!modelOutput.flaggedAsAbusive) return;
  await flagConversationForModeration(hotelId, conversationId, modelOutput.flagReason?.trim() || "comportement signalé par l'assistant", supabase);
}

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

  // Resolved once, reused by every layer of the price-communication policy
  // below (context redaction, spa's own price line via buildHotelInstructions,
  // and the output-side lock) — see pricePolicy.ts's own doc comment for why
  // this is never re-derived independently at each call site.
  const allowPriceCommunication = isPriceCommunicationAllowed(settings);

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
  // Moved up from just before groundingMode is decided (still computed only
  // from `history`, nothing later) so roomDiscoveryContinuationSignal below
  // can read it — the continuation check needs the SAME historyInput
  // instance answerGrounded/answerNoContext use, never a second derivation.
  const historyInput = history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  // Computed once, up front, and reused both to widen retrieval just below
  // and to gate the stay-request resolution block further down — a single
  // source of truth, never two independent calls that could silently drift
  // apart. Pure/synchronous (a handful of regexes + extractPartySize, see
  // gates.ts) — safe to call this early, before anything it depends on.
  const stayContextRelevant = shouldResolveStayContext(message);
  // A bare "montre-moi les chambres" never matches shouldResolveStayContext
  // (no date/party/keyword of its own — see gates.ts) yet is exactly the kind
  // of question retrieval needs to widen for: reused below for the same
  // retrieval-limit and stay-context-resolution decisions, never a second,
  // independent gate.
  //
  // roomDiscoveryContinuationSignal mirrors bookingIntentContinuation.ts's
  // own marker exactly (see roomDiscoveryContinuation.ts) — fixes a real,
  // stress-tested bug: a bare "2" answering "combien de personnes ?" carries
  // no discovery verb or room noun of its own, so isRoomDiscoveryIntent alone
  // can never recognize it. A FRESH, explicit isBookingIntent match on THIS
  // message always overrides a stale continuation signal (same
  // precedence-by-short-circuit principle as spaBookingCandidateActive/
  // partnerRequestFlowActive further down, not a new state machine) — so
  // "je veux réserver" still reactivates booking normally even after a
  // discovery detour.
  const roomDiscoveryContinuationSignal = lastAssistantMessageIndicatesRoomDiscoveryContinuation(historyInput);
  const roomDiscoveryIntentDetected =
    isRoomDiscoveryIntent(message) || (roomDiscoveryContinuationSignal && !isBookingIntent(message));

  // Moved up from just after retrieval (still depends only on hotelId/
  // supabase, nothing computed in between) so mentionedAccommodation below
  // can be resolved BEFORE relevantChunks is finalized — the scoped
  // retrieval augmentation just below needs to know the target source_url
  // ahead of time.
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
  // The single detection call for "did this message name a real,
  // already-curated accommodation category" — feeds BOTH
  // mentionsPreciseAccommodation (ROOM_DISCOVERY's own askPartySizeOnly
  // override, unchanged behavior) AND the scoped-retrieval augmentation
  // below (new this chantier) — one detection, two consumers, never two
  // competing recognition mechanisms. Always null for a hotel with no
  // accommodation_types rows yet, in which case isRoomDiscoveryIntent's own
  // generic/named distinction (accommodationRanking.ts) is the only signal
  // available for ROOM_DISCOVERY, and no scoped retrieval ever runs.
  const mentionedAccommodation = findMentionedAccommodation(
    message,
    (accommodationTypes ?? []).map((a) => ({ id: a.id, name: a.name, sourceUrl: a.source_url }))
  );
  const mentionsPreciseAccommodation = mentionedAccommodation !== null;

  let relevantChunks: RetrievedChunk[];
  try {
    const chunks = await retrieveKnowledgeHybrid({
      hotelId,
      query: message,
      limit: stayContextRelevant || roomDiscoveryIntentDetected ? ACCOMMODATION_RETRIEVAL_LIMIT : RETRIEVAL_LIMIT,
      supabase,
    });
    relevantChunks = selectHybridRelevantChunks(chunks);

    // Additive, bounded augmentation — see retrieve.ts:fetchAccommodationSourceChunks's
    // own doc comment for why this exists (a confirmed category match is a
    // stronger relevance signal than the embedding threshold above can
    // reliably capture on its own — see this chantier's own diagnostic).
    // Never replaces relevantChunks, never applies when the identified
    // category has no source_url (Superior/Deluxe PMR today) — falls
    // through to today's exact RAG behavior in that case. Best-effort: a
    // failure here never fails the whole turn, same discipline as every
    // other enrichment step in this function.
    if (mentionedAccommodation?.sourceUrl) {
      try {
        const scopedChunks = await fetchAccommodationSourceChunks({
          hotelId,
          sourceUrl: mentionedAccommodation.sourceUrl,
          supabase,
        });
        relevantChunks = mergeGuaranteedChunks(relevantChunks, scopedChunks);
      } catch (err) {
        console.error("answerQuestion: scoped accommodation retrieval failed", { hotelId, message: (err as Error).message });
      }
    }

    // Layer B of the price-communication policy (see pricePolicy.ts) — a
    // best-effort mitigation, not the guarantee itself (that's the
    // output-side lock below, in answerGrounded/answerNoContext).
    // UNCONDITIONAL — never gated on allowPriceCommunication: free RAG text
    // (general retrieval AND the accommodation-specific scoped retrieval
    // alike) is NEVER a certified price source, regardless of the hotel's
    // own toggle — see pricePolicy.ts:redactMonetaryAmounts' own doc
    // comment. Redacts ONLY the detected monetary substrings from each
    // chunk's own content, never drops a whole chunk: "45 m², climatisation,
    // 288 €" keeps "45 m²" and "climatisation" fully intact, only "288 €" is
    // neutralized. Applied to the FINAL merged set (general + scoped chunks
    // alike), after everything above.
    relevantChunks = relevantChunks.map((chunk) => ({ ...chunk, content: redactMonetaryAmounts(chunk.content) }));
  } catch (err) {
    console.error("answerQuestion: retrieval failed", { hotelId, message: (err as Error).message });
    return finalizeError(supabase, hotelId, conversationId, settings, Date.now() - startedAt);
  }

  const groundingMode: GroundingMode = relevantChunks.length > 0 ? "grounded" : "no_context";
  const model = openaiChatModel();

  // Cheap fallback, always available: a single-message regex extraction.
  let party: PartySize = extractPartySize(message);
  // Captured HERE, before any history-based enrichment below overwrites
  // `party` — see roomCatalogue's own gate further down for the real,
  // confirmed bug this fixes: lastAssistantMessageIndicatesRoomDiscoveryContinuation
  // (roomDiscoveryContinuation.ts) deliberately keeps roomDiscoveryIntentDetected
  // true for the REST of the conversation once a discovery flow starts —
  // correct for its own original purpose (mentionsPreciseAccommodation
  // override, scoped retrieval), but wrong to treat as "still a catalogue
  // turn" for every later, unrelated message once the party size already
  // became known once. "2 personnes" answering "combien de personnes ?"
  // must count as a real discovery turn; a later "bonjour", "merci", or
  // "avez-vous un parking ?" in the same conversation must not, even though
  // roomDiscoveryIntentDetected stays true for both via the same marker.
  // This flag distinguishes them: true only when THIS message alone states
  // a group size, never when the size is merely already known from earlier
  // history.
  const messageAloneStatesPartySize = isPartyKnown(party);
  // Deterministic, LLM-free multi-turn upgrade — tried BEFORE the costlier,
  // measurably unreliable OpenAI-based resolution below (see
  // partySize.ts:extractPartySizeFromHistory's own doc comment: a real,
  // repeated measurement showed resolveStayRequestFromHistory resolving a
  // plain "nous sommes 2" said one turn ago only about half the time).
  // Unconditional (not gated behind stayContextRelevant/roomDiscoveryIntentDetected)
  // — it's pure regex work over already-loaded history, never a network call,
  // and benefits BOOKING identically since both read the same `party`.
  if (!isPartyKnown(party)) {
    party = extractPartySizeFromHistory(historyInput) ?? party;
  }
  // Snapshot taken HERE, before mergeValidatedStayRequestIntoParty below can
  // touch `party` — see roomCatalogue's own gate further down for why. Both
  // extractPartySize (message alone) and extractPartySizeFromHistory above
  // are pure regex, never a network call — deterministicParty can only ever
  // be "known" from something the visitor literally typed as a number,
  // never inferred. Used EXCLUSIVELY for the roomCatalogue field (gate AND
  // the capacity filter behind its entries); every other use of `party`
  // below (prompt guidance, the model's own offered rankedCandidates,
  // booking) is completely unaffected and keeps benefiting from the
  // LLM-based resolution's broader phrasing coverage.
  const deterministicParty: PartySize = party;
  let availabilityCheckState: AvailabilityCheckState = { kind: "not_requested" };

  if (stayContextRelevant || roomDiscoveryIntentDetected) {
    try {
      const rawState = await resolveStayRequestFromHistory([...historyInput, { role: "user", content: message }], {
        referenceDate: new Date().toISOString().slice(0, 10),
        timeZone: FALLBACK_TIME_ZONE,
      });
      const validatedState: StayRequestState = validateStayRequestState(rawState);
      // See partySize.ts:mergeValidatedStayRequestIntoParty's own doc comment
      // for the exact rule (and the real bug it fixes: an adults-only
      // resolution like "nous sommes 2" used to be silently discarded).
      party = mergeValidatedStayRequestIntoParty(party, validatedState);

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

  // ROOM DISCOVERY CATALOGUE — deterministic, see RoomCatalogueEntry's own
  // doc comment for the original bug this fixes (a confirmed, reproduced
  // case: for a bare "2" reply continuing a room-discovery flow,
  // retrieveKnowledgeHybrid's own chunk coverage for that low-signal query
  // happened to be thin/absent for 2 of 7 compatible categories, and the
  // model's free-text reply dropped exactly those 2 — even though
  // buildAccommodationGuidance's own prompt instructions already named all
  // 7). Built directly from rankedCandidates right here — independent of
  // groundingMode, independent of whatever RAG chunks happened to be
  // retrieved this turn, independent of the model's own generation — so it
  // can never silently narrow.
  //
  // mentionsPreciseAccommodation is checked explicitly here, NOT folded
  // into "just reuse !askPartySizeOnly" — a real, confirmed regression:
  // shouldAskPartySizeOnly's own false already covers TWO different turn
  // shapes (party known on a genuinely generic discovery turn, OR a precise
  // category named this turn while roomDiscoveryIntentDetected is still
  // true only via the stale continuation marker — see
  // roomDiscoveryContinuation.ts). Gating the catalogue on !askPartySizeOnly
  // alone couldn't tell those two apart, so "Je veux voir la Deluxe" right
  // after a catalogue turn produced roomRecommendation=Deluxe AND a
  // 7-entry roomCatalogue in the SAME API response — a real backend
  // over-inclusion (confirmed by direct reproduction), not merely a
  // frontend history-rendering artifact. The catalogue must only exist on
  // a genuinely generic discovery turn — never once a precise category has
  // been named, even under a live continuation signal.
  //
  // isRoomDiscoveryIntent(message) / messageAloneStatesPartySize below is a
  // SECOND, broader real bug fixed the same way: roomDiscoveryIntentDetected
  // stays true for the rest of the conversation once the marker is set
  // (by design, for its own original purpose — see
  // roomDiscoveryContinuation.ts's own doc comment), so once a party size
  // became known once, EVERY later, wholly unrelated message ("bonjour",
  // "merci", "avez-vous un parking ?") also satisfied
  // "roomDiscoveryIntentDetected && !mentionsPreciseAccommodation &&
  // !askPartySizeOnly" and incorrectly re-triggered the full catalogue —
  // confirmed by direct reproduction (a genuinely fresh "bonjour" is
  // unaffected; the bug needs a room-discovery flow already established
  // earlier in the SAME conversation, e.g. after "montre-moi les
  // chambres" -> "2 personnes"). A catalogue turn requires either a FRESH
  // discovery phrasing on this exact message (isRoomDiscoveryIntent) or
  // this exact message itself supplying the group size (the "2 personnes"
  // reply to "combien de personnes ?") — never a stale flag alone.
  //
  // THIRD hardening, same principle applied one layer deeper: the gate
  // above (and shouldAskPartySizeOnly's own internal isPartyKnown check)
  // must never trust `party` once it may have been overwritten by
  // mergeValidatedStayRequestIntoParty — that merge folds in
  // resolveStayRequestFromHistory's OWN output, an LLM call. That call is
  // explicitly instructed never to guess an unstated value (see
  // extractStayRequest.ts's own buildExtractionInstructions), but this
  // field's whole reason to exist is to never depend on the model's good
  // behavior for something this visible — see RoomCatalogueEntry's own doc
  // comment. deterministicParty (captured earlier, purely from
  // extractPartySize/extractPartySizeFromHistory — regex only, no network
  // call) is used here instead of `party` for both the gate and the
  // catalogue's own candidate list, so a party size can only ever unlock
  // the catalogue when the visitor's own words, matched by plain regex,
  // actually said so. Every other use of `party`/`rankedCandidates` in this
  // function (prompt guidance, the model's own offered candidates,
  // booking) is untouched and keeps the LLM-resolved value.
  const catalogueRankedCandidates = applyAvailabilityToCandidates(filterAndRankAccommodations(candidates, deterministicParty), availabilityCheckState);
  const askPartySizeOnly = shouldAskPartySizeOnly(roomDiscoveryIntentDetected, mentionsPreciseAccommodation, deterministicParty);
  const isGenuineCatalogueTurn = isRoomDiscoveryIntent(message) || messageAloneStatesPartySize;
  const roomCatalogue: RoomCatalogueEntry[] =
    roomDiscoveryIntentDetected && !mentionsPreciseAccommodation && !askPartySizeOnly && isGenuineCatalogueTurn
      ? catalogueRankedCandidates.map((c) => ({
          accommodationTypeId: c.id,
          name: c.name,
          pageUrl: accommodationTypesById.get(c.id)?.source_url ?? null,
          maxGuests: c.maxGuests,
        }))
      : [];

  // Computed once, independent of groundingMode — drives the generic
  // booking CTA (see buildBookingAction) in both branches below. Two
  // independent signals, deliberately combined with OR: isBookingIntent
  // (a pure, cheap regex check on THIS message alone) catches a fresh "je
  // veux réserver" the first time it's said; lastAssistantMessageIndicatesBookingIntent
  // (bookingIntentContinuation.ts — the exact same invisible-marker
  // technique as spaBookingFlow.ts's own continuation marker, applied to
  // this different domain) catches every turn AFTER that, once the visitor
  // is already mid-conversation supplying the dates/party size the
  // assistant itself just asked for — text that never contains a booking
  // keyword at all ("20/09 au 22/09 2 personnes"). This was a real,
  // reported bug: the CTA silently vanished on exactly that second turn,
  // right when it was most useful. The marker is only ever set following a
  // genuine isBookingIntent match (see the reply-finalization block below in
  // both answerGrounded/answerNoContext), so a purely documentary
  // conversation ("la Suite Deluxe a la clim ?" -> "et pour 2 personnes ?")
  // never sets it in the first place and therefore never shows the CTA
  // either — continuation is never inferred from keywords alone.
  //
  // roomDiscoveryIntentDetected takes precedence for THIS turn only — reuses
  // the same precedence-by-short-circuit principle already used below for
  // partnerRequestFlowActive/spaBookingCandidateActive, not a new state
  // machine: a fresh "montre-moi les chambres" right after "je veux
  // réserver" must suppress the Réserver CTA this turn (see the ROOM_DISCOVERY
  // report), without ever writing a "clear the marker" operation — the
  // marker simply isn't re-applied to this turn's reply (see the
  // withBookingIntentMarker calls in answerGrounded/answerNoContext below),
  // so it naturally stops propagating, and a later, fresh "je veux réserver"
  // still reactivates booking normally since isBookingIntent fires
  // independently of any of this.
  const bookingIntentDetected =
    !roomDiscoveryIntentDetected && (isBookingIntent(message) || lastAssistantMessageIndicatesBookingIntent(historyInput));

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

  // Spa booking vs. partner-request precedence.
  //
  // isPartnerIntent's own keyword patterns (features/rag/partners.ts)
  // deliberately include "spa"/"bien-être"/"massage" — a "wellness partner"
  // is a legitimate partner category. That means partnerIntentDetected is
  // ALWAYS true for a message like "puis-je réserver une séance de spa ?",
  // which would silently and permanently starve the spa-booking flow below
  // if a bare "partner intent fired" check were allowed to win by default —
  // this was a real, hotel-breaking bug (every spa question was routed to
  // the generic wellness-partner flow, never to this hotel's own configured
  // spa booking, however it was configured). The fix: for a hotel that has
  // actually ENABLED spa booking, its own in-house spa always takes
  // precedence over a merely keyword-overlapping "wellness partner" guess —
  // the partner flow is reserved for hotels that have NOT configured spa
  // booking, where "spa" genuinely has nowhere else to go but a registered
  // wellness partner, if any. A real, already-persisted partner_request in
  // progress (activePartnerRequest) still always wins outright: abandoning
  // an in-flight request the guest already started confirming would be far
  // more confusing than this keyword overlap ever is.
  const spaBookingCandidateActive = activePartnerRequest === null && (isSpaBookingIntent(message) || lastAssistantMessageContinuesSpaBooking(historyInput));
  const todayIso = new Date().toISOString().slice(0, 10);

  // Cheap, settings-only lookup — reused as-is below if no date gets
  // resolved this turn, and never runs the costlier extraction call
  // (resolveSpaBookingRequestFromHistory) unless spa actually wins the
  // precedence decision.
  let spaAvailability: SpaAvailability = { enabled: false, date: todayIso, pricePerPerson: null, allowNonResidents: false, approvalMode: "auto", slots: [] };
  if (spaBookingCandidateActive) {
    try {
      spaAvailability = await getSpaAvailability(hotelId, todayIso, supabase);
    } catch (err) {
      console.error("answerQuestion: spa availability lookup failed", { hotelId, message: (err as Error).message });
    }
  }

  const spaBookingFlowActive = spaBookingCandidateActive && spaAvailability.enabled;
  const partnerRequestFlowActive = activePartnerRequest !== null || (partnerIntentDetected && !spaBookingFlowActive);

  let partnerCandidates: RagPartner[] = [];
  let allPartners: RagPartner[] = [];
  // What buildPartnerRequestGuidance is actually allowed to OFFER for a
  // BRAND NEW request this turn — defaults to allPartners (unfiltered,
  // matches today's behavior for a category-agnostic message). Narrowed to
  // the detected category below, but ONLY when there's no already-in-progress
  // request to preserve (activePartnerRequest !== null keeps its own
  // continuity untouched — see prompt.ts's own early-return branch for that
  // case, which never even reads this list). Deliberately a SEPARATE
  // variable from allPartners: the id-VALIDATION list passed to
  // processPartnerRequestTurn (see applyPartnerRequestFlow below) must stay
  // the full, unfiltered allPartners regardless — narrowing what's merely
  // OFFERED in the prompt can never shrink what's still a valid target.
  let partnerRequestEligiblePartners: RagPartner[] = [];
  if (partnerRequestFlowActive) {
    allPartners = await loadActiveHotelPartners(supabase, hotelId);
    partnerRequestEligiblePartners = allPartners;
    if (partnerIntentDetected) {
      const category = detectRelevantPartnerCategory(message);
      const limit = wantsAllPartners(message) ? ALL_PARTNERS_LIMIT : DEFAULT_PARTNER_LIMIT;
      partnerCandidates = rankPartnerCandidates(allPartners, { category, limit });
      // A specific category was detected for THIS message — never offer a
      // NEW request against a partner outside it (same "no cross-category
      // fallback" fix as rankPartnerCandidates above). Uncapped on purpose:
      // unlike partnerCandidates (a display cap), every real match in this
      // category must remain offerable, not just the first DEFAULT_PARTNER_LIMIT.
      if (category && activePartnerRequest === null) {
        partnerRequestEligiblePartners = allPartners.filter((partner) => partner.category === category);
      }
    }
  }

  // Orthogonal to groundingMode and to every intent-detection flag above —
  // unlike partners, hotel events have no keyword-based intent detector, so
  // this is loaded on EVERY turn (see prompt.ts's own doc comment on
  // BuildHotelInstructionsParams.events). loadActiveHotelEvents never
  // throws — a query failure here degrades to "no events this turn", never
  // fails the whole chat turn.
  const events = await loadActiveHotelEvents(supabase, hotelId, new Date().toISOString().slice(0, 10));

  let resolvedSpaBookingRequest: SpaBookingRequestState = { bookingDate: null, slotStart: null, partySize: null };
  if (spaBookingFlowActive) {
    try {
      const rawSpaState = await resolveSpaBookingRequestFromHistory([...historyInput, { role: "user", content: message }], todayIso);
      resolvedSpaBookingRequest = validateSpaBookingRequestState(rawSpaState);
      // Only refetch when a specific date was actually resolved — otherwise
      // the "today" availability already fetched above (still accurate:
      // hours/price/policy are date-independent) is reused as-is.
      if (resolvedSpaBookingRequest.bookingDate) {
        spaAvailability = await getSpaAvailability(hotelId, resolvedSpaBookingRequest.bookingDate, supabase);
      }
    } catch (err) {
      // Best-effort enrichment — never fails the whole turn, same discipline
      // as the stay-request resolution block above.
      console.error("answerQuestion: spa booking resolution failed", { hotelId, message: (err as Error).message });
    }
  }

  // The SUFFICIENT half of canCommunicatePrice = hotelAllowsPriceCommunication
  // && priceIsCertified (see pricePolicy.ts's own doc comment) — the exact,
  // server-computed amounts the output-side lock (in answerGrounded/
  // answerNoContext below) will accept regardless of what the model itself
  // produces. Mirrors, field for field, the same three conditions
  // buildSpaAvailabilityGuidance itself uses to decide whether to show a
  // real priceLine at all (see prompt.ts) — never a second, independently
  // derived check that could silently drift from what the model was
  // actually told. Empty today for anything except the spa's own
  // structured price: no accommodation price is certified yet (see this
  // chantier's own report).
  const authorizedPriceAmounts: number[] =
    allowPriceCommunication && spaBookingFlowActive && spaAvailability.pricePerPerson !== null ? [spaAvailability.pricePerPerson] : [];

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
      roomDiscoveryIntentDetected,
      mentionsPreciseAccommodation,
      mentionedAccommodationId: mentionedAccommodation?.id ?? null,
      allowPriceCommunication,
      authorizedPriceAmounts,
      roomCatalogue,
      partnerIntentDetected,
      partnerCandidates,
      normalizedPhoneE164,
      activePartnerRequest,
      partnerRequestFlowActive,
      allPartners,
      partnerRequestEligiblePartners,
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
    party,
    availabilityCheckState,
    bookingIntentDetected,
    roomDiscoveryIntentDetected,
    mentionsPreciseAccommodation,
    allowPriceCommunication,
    authorizedPriceAmounts,
    roomCatalogue,
    partnerIntentDetected,
    partnerCandidates,
    normalizedPhoneE164,
    activePartnerRequest,
    partnerRequestFlowActive,
    allPartners,
    partnerRequestEligiblePartners,
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
/**
 * Authority order for WHICH accommodation this turn's recommendation is
 * about — a real, confirmed bug fix: a deterministic, name-based match on
 * the CURRENT message ("la Deluxe fait quelle surface ?" ->
 * findMentionedAccommodation resolves Deluxe with certainty) was being
 * silently overridden by the model's own free choice of
 * recommendedAccommodationTypeId, which once picked "Deluxe PMR" instead —
 * two unrelated mechanisms that happened to disagree, with the WEAKER one
 * (an unconstrained model choice) winning by construction (it was simply
 * the only one ever consulted here).
 *
 * mentionedAccommodationId — never the model's own output — now takes
 * priority whenever it's non-null. It still goes through the EXACT same
 * validation as the model's own choice would (must be present in
 * rankedCandidates, i.e. not excluded by the capacity filter, and must
 * belong to this hotel) — a precise mention of a capacity-incompatible
 * category (rare, e.g. naming a 6-person room for an already-known party of
 * 8) yields no recommendation at all rather than silently falling back to
 * whatever the model separately proposed, which would reopen exactly the
 * class of bug this fixes.
 */
export function resolveAuthoritativeAccommodationId(mentionedAccommodationId: string | null, recommendedAccommodationTypeId: string | null): string | null {
  return mentionedAccommodationId ?? recommendedAccommodationTypeId;
}

async function buildRoomRecommendation(
  supabase: SupabaseClient,
  params: {
    hotelId: string;
    recommendedAccommodationTypeId: string | null;
    /** See resolveAuthoritativeAccommodationId's own doc comment — a deterministic match on the CURRENT message always wins over the model's own free choice. */
    mentionedAccommodationId: string | null;
    rankedCandidates: RankedCandidate[];
    accommodationTypesById: Map<string, AccommodationType>;
    /** hotels.booking_url, passed straight through from the already-loaded hotel row — see answerGrounded's call site. Never sourced from the model or the visitor's message. */
    bookingUrl: string | null;
  }
): Promise<RoomRecommendation | null> {
  const { hotelId, recommendedAccommodationTypeId, mentionedAccommodationId, rankedCandidates, accommodationTypesById, bookingUrl } = params;
  const effectiveAccommodationTypeId = resolveAuthoritativeAccommodationId(mentionedAccommodationId, recommendedAccommodationTypeId);
  if (!effectiveAccommodationTypeId) return null;

  const matched = rankedCandidates.find((c) => c.id === effectiveAccommodationTypeId);
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
    roomDiscoveryIntentDetected: boolean;
    mentionsPreciseAccommodation: boolean;
    /**
     * A precise accommodation already resolved DETERMINISTICALLY from the
     * CURRENT message (see accommodationRanking.ts:findMentionedAccommodation)
     * — the authority for roomRecommendation below whenever non-null, ahead
     * of whatever recommendedAccommodationTypeId the model itself proposes.
     * See buildRoomRecommendation's own doc comment for the exact rule and
     * the bug this fixes (a real, confirmed Deluxe -> Deluxe PMR mix-up).
     */
    mentionedAccommodationId: string | null;
    allowPriceCommunication: boolean;
    /** The exact, server-computed amounts certified for this turn — see answer.ts's own authorizedPriceAmounts and pricePolicy.ts:containsUnauthorizedMonetaryAmount. */
    authorizedPriceAmounts: number[];
    /** Deterministic, server-computed — see RoomCatalogueEntry's own doc comment (types.ts) and answer.ts's own roomCatalogue computation. */
    roomCatalogue: RoomCatalogueEntry[];
    partnerIntentDetected: boolean;
    partnerCandidates: RagPartner[];
    normalizedPhoneE164: string | null;
    activePartnerRequest: PartnerRequest | null;
    partnerRequestFlowActive: boolean;
    allPartners: RagPartner[];
    /** What may be OFFERED for a brand new request this turn — see answer.ts's own computation (answerQuestion). Never used for id validation, that's still allPartners (via applyPartnerRequestFlow below). */
    partnerRequestEligiblePartners: RagPartner[];
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
    roomDiscoveryIntentDetected,
    mentionsPreciseAccommodation,
    mentionedAccommodationId,
    allowPriceCommunication,
    authorizedPriceAmounts,
    roomCatalogue,
    partnerIntentDetected,
    partnerCandidates,
    normalizedPhoneE164,
    activePartnerRequest,
    partnerRequestFlowActive,
    allPartners,
    partnerRequestEligiblePartners,
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
    roomDiscoveryIntentDetected,
    mentionsPreciseAccommodation,
    allowPriceCommunication,
    partnerIntentDetected,
    partnerCandidates,
    partnerRequestFlowActive,
    activePartnerRequest,
    allActivePartnersForRequest: partnerRequestEligiblePartners,
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

    // Orthogonal to partner/spa flow gating below — a visitor can be flagged
    // mid-partner-request just as easily as mid-greeting.
    await applyModerationFlag(hotelId, conversationId, response.output_parsed, supabase);

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

    // Layer C of the price-communication policy (see pricePolicy.ts) — the
    // AUTHORITATIVE, deterministic guarantee: applied to the FINAL composed
    // reply (after partner/spa flow suffixes, still before persistence),
    // catching a monetary amount from ANY source (model generation, a
    // partner/event description, hallucination) regardless of whether the
    // context-redaction layer above already ran. Compares against
    // authorizedPriceAmounts — the server's own certified list for this
    // turn — never a blanket "any amount at all", so a legitimately
    // certified spa price can coexist with this same lock rejecting an
    // uncertified one in the same reply (see pricePolicy.ts:
    // containsUnauthorizedMonetaryAmount's own doc comment). Never a
    // partial in-place redaction — see PRICE_LOCKED_FALLBACK_REPLY's own
    // doc comment for why a full replacement is deliberate. Placed BEFORE
    // the booking/room-discovery markers below so those continuation
    // mechanisms are entirely unaffected: whichever reply ends up here
    // (original or the fallback) still gets marked normally.
    if (containsUnauthorizedMonetaryAmount(reply, authorizedPriceAmounts)) {
      reply = PRICE_LOCKED_FALLBACK_REPLY;
    }

    // See bookingIntentContinuation.ts's own doc comment: marks THIS reply so
    // a later turn with no booking keyword at all (dates, "oui", a bare
    // name) still keeps the Réserver CTA — never gated on which flow branch
    // ran above, since a booking-relevant turn can equally arrive alongside
    // a partner/spa exchange or on its own.
    if (bookingIntentDetected) {
      reply = withBookingIntentMarker(reply);
    }
    // See roomDiscoveryContinuation.ts's own doc comment: marks THIS reply so
    // a later turn with no discovery verb/room noun of its own (a bare "2"
    // answering "combien de personnes ?") is still recognized as continuing
    // the flow. Independent of bookingIntentDetected above — mutually
    // exclusive in practice (see answer.ts's own roomDiscoveryIntentDetected
    // computation), never both at once.
    if (roomDiscoveryIntentDetected) {
      reply = withRoomDiscoveryMarker(reply);
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
    mentionedAccommodationId,
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

  return { reply, sources: relevantChunks, answerStatus: "answered", roomRecommendation, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt, roomCatalogue };
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
    party: PartySize;
    availabilityCheckState: AvailabilityCheckState;
    bookingIntentDetected: boolean;
    roomDiscoveryIntentDetected: boolean;
    mentionsPreciseAccommodation: boolean;
    allowPriceCommunication: boolean;
    /** See answerGrounded's identical field for the full doc comment — answerNoContext never builds a roomRecommendation at all, but still needs this for the output-side lock's authorizedPriceAmounts, threaded alongside. */
    authorizedPriceAmounts: number[];
    /** See answerGrounded's identical field — roomCatalogue is independent of groundingMode, so a no_context turn still needs it threaded through. */
    roomCatalogue: RoomCatalogueEntry[];
    partnerIntentDetected: boolean;
    partnerCandidates: RagPartner[];
    normalizedPhoneE164: string | null;
    activePartnerRequest: PartnerRequest | null;
    partnerRequestFlowActive: boolean;
    allPartners: RagPartner[];
    /** What may be OFFERED for a brand new request this turn — see answer.ts's own computation (answerQuestion). Never used for id validation, that's still allPartners (via applyPartnerRequestFlow below). */
    partnerRequestEligiblePartners: RagPartner[];
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
    party,
    availabilityCheckState,
    bookingIntentDetected,
    roomDiscoveryIntentDetected,
    mentionsPreciseAccommodation,
    allowPriceCommunication,
    authorizedPriceAmounts,
    roomCatalogue,
    partnerIntentDetected,
    partnerCandidates,
    normalizedPhoneE164,
    activePartnerRequest,
    partnerRequestFlowActive,
    allPartners,
    partnerRequestEligiblePartners,
    events,
    spaBookingFlowActive,
    spaAvailability,
    resolvedSpaBookingRequest,
  } = params;

  const instructions = buildHotelInstructions({
    hotel,
    settings,
    groundingMode: "no_context",
    party,
    availabilityCheckState,
    bookingIntentDetected,
    roomDiscoveryIntentDetected,
    mentionsPreciseAccommodation,
    allowPriceCommunication,
    partnerIntentDetected,
    partnerCandidates,
    partnerRequestFlowActive,
    activePartnerRequest,
    allActivePartnersForRequest: partnerRequestEligiblePartners,
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

    // Orthogonal to partner/spa flow gating below — see answerGrounded's own
    // identical call for why this runs unconditionally, right after parse.
    await applyModerationFlag(hotelId, conversationId, response.output_parsed, supabase);

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

    // See pricePolicy.ts and answerGrounded's identical call — independent
    // of groundingMode, same reasoning: the authoritative guarantee must
    // apply whether or not any RAG context was even retrieved this turn.
    if (containsUnauthorizedMonetaryAmount(reply, authorizedPriceAmounts)) {
      reply = PRICE_LOCKED_FALLBACK_REPLY;
    }

    // See bookingIntentContinuation.ts's own doc comment and answerGrounded's
    // identical call — independent of groundingMode, same reasoning.
    if (bookingIntentDetected) {
      reply = withBookingIntentMarker(reply);
    }
    // See roomDiscoveryContinuation.ts's own doc comment and answerGrounded's
    // identical call — independent of groundingMode, same reasoning.
    if (roomDiscoveryIntentDetected) {
      reply = withRoomDiscoveryMarker(reply);
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

  return { reply, sources: [], answerStatus, roomRecommendation: null, action, partnerRecommendations, partnerRequestPhonePrompt, spaBookingPhonePrompt, roomCatalogue };
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
  return { reply, sources: [], answerStatus: "error", roomRecommendation: null, action: null, partnerRecommendations: [], partnerRequestPhonePrompt: null, spaBookingPhonePrompt: null, roomCatalogue: [] };
}
