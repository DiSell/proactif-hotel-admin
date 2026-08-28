import type { HotelPartnerCategory } from "@/types/database";

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
}
