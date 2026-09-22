import type { HotelMediaCategory, HotelPartnerCategory } from "@/types/database";

/**
 * Minimal, RAG-pipeline-specific projection of hotel_partners — deliberately
 * NOT HotelPartner (types/database.ts), which carries every column
 * including operational/internal ones (request_phone_e164, email,
 * consent_status, consent_requested_at/consent_responded_at) this pipeline
 * has no business touching. Every field here was traced field-by-field as
 * genuinely read somewhere in the RAG pipeline (partners.ts/prompt.ts/
 * answer.ts/partnerRequestFlow.ts) — never copied from HotelPartner's full
 * shape "just in case". See features/rag/partners.ts:loadActiveHotelPartners,
 * the only place this type's instances are ever created from a real DB row.
 * consent_status is deliberately excluded even though it gates the SQL
 * query itself (`.eq("consent_status", "accepted")`) — filtering happens at
 * the database level, so the value is never read again on the returned rows.
 */
export interface RagPartner {
  id: string;
  hotel_id: string;
  name: string;
  category: HotelPartnerCategory;
  description: string | null;
  address: string | null;
  phone: string | null;
  opening_hours: string | null;
  website_url: string | null;
  booking_url: string | null;
  is_active: boolean;
  priority: number;
}

export interface Chunk {
  content: string;
  chunkIndex: number;
  tokenCount: number | null;
  metadata: Record<string, unknown>;
}

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  content: string;
  /** Vector (cosine) similarity — unchanged meaning, still what message_sources.similarity_score and every existing threshold check read. */
  similarity: number;
  /**
   * Lexical coverage score (see match_knowledge_chunks_hybrid,
   * 0013_hybrid_retrieval.sql) — the fraction of the query's own
   * significant lexemes found verbatim in this chunk, [0,1]. Absent
   * (undefined) for a chunk retrieved via the legacy retrieveKnowledge()/
   * match_knowledge_chunks() path, which never computes it — never
   * defaulted to 0 there, so a caller can tell "not computed" apart from
   * "computed as zero overlap".
   */
  lexicalScore?: number;
  /**
   * knowledge_sources.source_url / last_synced_at for this chunk's source
   * (0016_rag_freshness.sql) — null for a non-URL source (text/faq/
   * internal_note/document) or one never successfully indexed. Surfaced to
   * the model by buildKnowledgeReferenceBlock (prompt.ts) as citable
   * reference data, never fabricated when absent — see also
   * features/rag/staleness.ts for how the app itself reasons about "is this
   * too old".
   */
  sourceUrl: string | null;
  lastSyncedAt: string | null;
}

export type AnswerStatus = "answered" | "fallback" | "error" | "handoff";

/**
 * Internal only — never persisted. "grounded" means relevant knowledge
 * chunks were found and passed to the model; "no_context" means none were,
 * but the model still runs (with its identity/behavior/capability rules and
 * no knowledge block) instead of being short-circuited to a static reply.
 */
export type GroundingMode = "grounded" | "no_context";

/**
 * Present only when the model recommended a specific accommodation AND the
 * server independently validated recommendedAccommodationTypeId against the
 * exact candidate list actually offered that turn (see answer.ts) — never
 * built from a raw, unverified model output.
 */
export interface RoomRecommendation {
  accommodationTypeId: string;
  name: string;
  photos: { url: string; alt: string | null }[];
  pageUrl: string | null;
  /**
   * hotels.booking_url, read straight from the database row — never from
   * the model's structured output (neither groundedReplySchema nor
   * noContextReplySchema in answer.ts declares any URL field, so there is
   * no field for the model to populate this from even accidentally) and
   * never derived from the visitor's message. Null when the hotel hasn't
   * configured one.
   */
  bookingUrl: string | null;
}

/**
 * Generic call-to-action, independent of RoomRecommendation — covers a
 * reservation/availability/price intent that isn't tied to a specific
 * recommended accommodation (e.g. "avez-vous de la place ?", "combien coûte
 * une nuit ?"). Decided entirely server-side from the hotel's own
 * configuration (see bookingCtaKind/buildBookingAction in
 * features/rag/bookingCta.ts and answer.ts) — the model only ever detects
 * the intent, never the action:
 *
 * - "booking": hotels.booking_action_mode = "url" and booking_url is
 *   configured — `url` is always that column, read straight from the
 *   database row, never from the model, the RAG knowledge base, or the
 *   visitor's message.
 * - "host_booking": hotels.booking_action_mode = "host_widget" with a
 *   valid trigger configured — the widget asks public/widget.js to open
 *   the booking module already present on the hotel's own site. NEVER
 *   carries a selector or any trigger detail: that stays entirely inside
 *   public/widget.js's own trusted config, fetched independently from the
 *   public config endpoint — this ChatAction only signals "show a Réserver
 *   button that does that", nothing about how.
 */
export type ChatAction = { type: "booking"; label: string; url: string } | { type: "host_booking"; label: string };

/**
 * A local partner's own CTA (features/rag/partners.ts:buildPartnerAction) —
 * distinct from ChatAction above (booking-intent, singular, hotel-wide) and
 * from RoomRecommendation.bookingUrl (a specific accommodation). Several
 * PartnerRecommendations can each carry their own action independently —
 * never a single global action forced across all of them (product spec
 * point 10). "partner_booking" wins over "partner_website" when a partner
 * has both a booking_url and a website_url — see buildPartnerAction.
 */
export type PartnerAction = { type: "partner_booking"; label: string; url: string } | { type: "partner_website"; label: string; url: string };

/**
 * Present only when the model recommended this partner AND the server
 * independently validated its id against the exact candidate list actually
 * offered that turn (see answer.ts) — never built from a raw, unverified
 * model output, same discipline as RoomRecommendation. Every field here
 * (except action, computed server-side) is read straight from
 * hotel_partners — the model can reformulate description in the visitor's
 * language but never fabricates a fact the hotel didn't enter (see
 * features/rag/partners.ts, prompt.ts's buildPartnerGuidance, and hotel_partners
 * in supabase/migrations/0015_hotel_partners.sql).
 */
export interface PartnerRecommendation {
  id: string;
  name: string;
  category: HotelPartnerCategory;
  description: string | null;
  address: string | null;
  phone: string | null;
  openingHours: string | null;
  websiteUrl: string | null;
  bookingUrl: string | null;
  action: PartnerAction | null;
}

/**
 * Everything the structured widget phone form (PublicWidgetChat.tsx) needs
 * to render itself AND to echo back, unmodified, to
 * POST /api/widget/[widgetKey]/partner-request/phone once the visitor
 * submits a number — see features/rag/partnerRequestFlow.ts's own doc
 * comment on why this is carried through the client rather than persisted
 * server-side: no partner_requests row exists yet at this point (creation
 * is deliberately deferred until the phone itself is known — see
 * processPartnerRequestTurn), so there is nothing to attach it to.
 *
 * Not sensitive data: partnerId is independently REVALIDATED server-side
 * before ever being used (never trusted as-is, same discipline as every
 * other model-sourced id in this codebase — see
 * submitStructuredGuestPhone); the remaining fields are free-text content
 * the visitor already typed into the chat themselves, echoed back to
 * finish the same request, not a new trust boundary.
 */
export interface PendingPartnerRequestFields {
  partnerId: string;
  requestedDate: string | null;
  requestedTime: string | null;
  partySize: number | null;
  details: string | null;
  guestName: string | null;
}

/**
 * Present exactly when the widget must show the dedicated, structured
 * phone-collection form instead of (or in addition to) the model's own
 * conversational reply text — a deterministic backend signal, never
 * something the widget infers by parsing `reply`. See
 * features/widget/PublicWidgetChat.tsx and
 * features/rag/partnerRequestFlow.ts:processPartnerRequestTurn.
 */
export interface PartnerRequestPhonePrompt {
  partnerName: string;
  pendingRequest: PendingPartnerRequestFields;
}

/**
 * Everything the structured widget phone form needs to render itself AND to
 * echo back, unmodified, to POST /api/widget/[widgetKey]/spa-booking/phone
 * once the visitor submits a number — mirrors PendingPartnerRequestFields's
 * own doc comment exactly, with the same reasoning: no spa_bookings row
 * exists yet at this point (see features/rag/spaBookingFlow.ts's own header
 * comment on why spa bookings carry no persisted in-progress state at all —
 * a stronger version of the same "nothing to attach it to yet" reasoning).
 * bookingDate/slotStart/partySize were independently validated against a
 * real calendar/capacity check before this prompt was ever shown (see
 * spaBookingFlow.ts's own doc comment on why these never come from the
 * model's own structured output) — not sensitive data, and re-validated
 * again server-side before ever being used (submitStructuredSpaBookingPhone
 * never trusts them as-is).
 */
export interface PendingSpaBookingFields {
  bookingDate: string;
  slotStart: string;
  partySize: number;
  guestName: string | null;
  isNonResident: boolean;
  notes: string | null;
}

/**
 * Present exactly when the widget must show the dedicated, structured
 * phone-collection form for a spa booking instead of (or in addition to)
 * the model's own conversational reply text — same deterministic-backend-
 * signal discipline as PartnerRequestPhonePrompt. Never both
 * partnerRequestPhonePrompt and spaBookingPhonePrompt non-null the same
 * turn (see answer.ts: only one of the two flows ever runs per turn).
 */
export interface SpaBookingPhonePrompt {
  pendingBooking: PendingSpaBookingFields;
}

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — everything the structured widget
 * phone form needs to render itself AND to echo back, unmodified, to
 * POST /api/widget/[widgetKey]/service-request/phone once the visitor
 * submits a number. Mirrors PartnerRequestPhonePrompt/SpaBookingPhonePrompt's
 * own doc comment exactly: no hotel_service_requests row exists yet at this
 * point (see features/rag/humanHandoverFlow.ts — creation is deliberately
 * deferred until the phone itself is known).
 *
 * guestMessage is the triggering message, verbatim — never re-summarized by
 * an LLM (see this chantier's own spec, section 4: "sans hallucination
 * LLM"). mayAskRoomNumber is a deterministic signal
 * (features/rag/humanHandover.ts:isLikelyCurrentGuestMessage) telling the
 * widget whether to ALSO show an optional room-number field — never asked of
 * every visitor, never deduced/invented when absent (section 3).
 */
export interface PendingHandoverFields {
  guestMessage: string;
  mayAskRoomNumber: boolean;
}

/**
 * Present exactly when the widget must show the dedicated, structured phone
 * form for a human-handover (callback) request — same deterministic-backend-
 * signal discipline as PartnerRequestPhonePrompt/SpaBookingPhonePrompt.
 * Independent of those two: see answer.ts's own short-circuit, which never
 * fires while a partner-request or spa-booking flow already has priority
 * this turn.
 */
export interface HandoverPhonePrompt {
  pendingHandover: PendingHandoverFields;
}

export interface AnswerQuestionResult {
  reply: string;
  sources: RetrievedChunk[];
  answerStatus: AnswerStatus;
  roomRecommendation: RoomRecommendation | null;
  /**
   * Null whenever a RoomRecommendation with its own bookingUrl was already
   * produced this turn (see answer.ts's buildBookingAction call sites) —
   * deliberately never both at once, to avoid two "Réserver" buttons for
   * the same link in the same turn.
   */
  action: ChatAction | null;
  /**
   * Additive field (see features/rag/partners.ts) — always an array, never
   * null, empty when no partner was relevant this turn (including when no
   * partner intent was even detected). Independent of groundingMode and of
   * `action`/`roomRecommendation` above: several partners can be
   * recommended in the same turn as a room or a booking CTA without
   * conflict, each carrying its own PartnerAction.
   */
  partnerRecommendations: PartnerRecommendation[];
  /**
   * Additive field, always present (never omitted), null on every turn
   * that doesn't need it — see PartnerRequestPhonePrompt's own doc comment.
   * Never derived from `reply`'s text by the widget; always this explicit
   * field.
   */
  partnerRequestPhonePrompt: PartnerRequestPhonePrompt | null;
  /** Additive field, always present, null on every turn that doesn't need it — see SpaBookingPhonePrompt's own doc comment. */
  spaBookingPhonePrompt: SpaBookingPhonePrompt | null;
  /**
   * The deterministic list of capacity-(and availability-)compatible
   * accommodation categories for a room-discovery turn — see
   * RoomCatalogueEntry's own doc comment. Always an array, never null;
   * empty on every turn that isn't a room-discovery turn with a known party
   * (same gating accommodationRanking.ts:shouldAskPartySizeOnly already
   * uses for the model's own prose guidance, so the two can never disagree
   * about when a catalogue should exist at all). The widget should render
   * this directly rather than parsing `reply` for room names: `reply` is
   * free-text commentary the model writes around it and may summarize,
   * reorder, or omit entries in prose — this field is the one guaranteed-
   * complete source of truth.
   */
  roomCatalogue: RoomCatalogueEntry[];
  /**
   * INFORMATION DÉTERMINISTE chantier — the deterministic, exhaustive list
   * of the establishment's accommodation categories for a genuine
   * INFORMATION turn (see accommodationRanking.ts:isAccommodationInformationIntent
   * and answer.ts's own informationIntentDetected). Independent field, own
   * gate, own semantics — deliberately NOT the same field as roomCatalogue
   * (CATALOGUE's own field stays exclusively CATALOGUE's, unchanged, never
   * repurposed): reuses RoomCatalogueEntry's exact shape (no second,
   * parallel id/name/pageUrl/maxGuests type) since the data need is
   * identical, but the two fields are populated by different intentions and
   * are never both non-empty the same turn. Always an array, never null;
   * empty on every turn that isn't a genuine INFORMATION turn.
   *
   * Unlike roomCatalogue, never filtered by capacity/party: INFORMATION
   * answers "what categories does this establishment have" independent of
   * any stated group size — every active accommodation_types row is always
   * listed. Fixes a real, confirmed bug (proven by 5/5 real invocations,
   * see this chantier's own audit): the model's own free-text INFORMATION
   * reply can non-deterministically omit a category or its capacity even
   * though buildAccommodationGuidance already gave it the complete,
   * correct data every single time — this field is the guaranteed-complete
   * source of truth the widget should render directly, exactly the same
   * "server computes truth, model narrates around it" discipline as
   * roomCatalogue/RoomRecommendation.
   */
  accommodationSummary: RoomCatalogueEntry[];
  /**
   * hotel_media equivalent of RoomRecommendation, for general-establishment
   * photos (pool, spa, fitness...) rather than a specific accommodation —
   * see features/rag/hotelMediaGallery.ts. Deterministic, server-computed:
   * the category is never chosen by the model, only detected from the raw
   * message text (detectHotelMediaCategory) and gated by an explicit
   * visual/photo request (isHotelMediaPhotoRequest) — a bare factual
   * question ("avez-vous une piscine ?") never populates this field. Null
   * whenever no category was detected, no visual intent was detected, OR
   * the detected category currently has zero selected photos — NEVER an
   * object with an empty `photos` array, and NEVER a different category's
   * photos as a fallback (see loadSelectedHotelMediaPhotos's own doc
   * comment). Independent of roomRecommendation: a room-specific request
   * ("Montrez-moi la Deluxe") never populates this field, since accommodation
   * names don't match any hotel_media category keyword.
   */
  hotelMediaGallery: HotelMediaGallery | null;
  /**
   * HUMAN HANDOVER / RAPPEL SMS chantier — additive field, always present,
   * null on every turn that doesn't need it — see HandoverPhonePrompt's own
   * doc comment. Never derived from `reply`'s text by the widget; always
   * this explicit field, same discipline as partnerRequestPhonePrompt/
   * spaBookingPhonePrompt.
   */
  handoverPhonePrompt: HandoverPhonePrompt | null;
}

/** See AnswerQuestionResult.hotelMediaGallery's own doc comment. */
export interface HotelMediaGallery {
  category: HotelMediaCategory;
  /** French label — reused from features/hotelMedia/schema.ts's HOTEL_MEDIA_CATEGORY_LABEL, never a second, parallel label map. */
  label: string;
  photos: { url: string; alt: string | null }[];
}

/**
 * ONE entry in the deterministic room-discovery catalogue above — computed
 * directly from rankedCandidates (accommodationRanking.ts:filterAndRankAccommodations,
 * already capacity- and availability-filtered), never from the model's own
 * output. Fixes a real, confirmed bug: for a bare "2" reply continuing a
 * room-discovery flow, the model's free-text catalogue reply silently
 * dropped 2 of 7 compatible categories — traced to uneven RAG chunk
 * coverage per category (rich descriptive chunks for some, none for
 * others) biasing which ones the model chose to narrate, even though the
 * deterministic candidate list handed to it already named all 7. Moving
 * the actual guaranteed listing into a structured field (mirroring
 * RoomRecommendation's own "server computes truth, model narrates around
 * it" precedent) fixes this architecturally rather than by asking the
 * model harder to remember every entry.
 *
 * Deliberately carries no price field at all — this structure can never
 * leak a tariff, by construction, regardless of allow_price_communication.
 *
 * Also reused, unchanged, as accommodationSummary's own entry shape (see
 * AnswerQuestionResult.accommodationSummary's doc comment) — the exact same
 * proven bug class, hit by a different intention (INFORMATION rather than
 * CATALOGUE) — never a second, parallel type with the same four fields.
 */
export interface RoomCatalogueEntry {
  accommodationTypeId: string;
  name: string;
  pageUrl: string | null;
  maxGuests: number | null;
}
