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
  similarity: number;
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
 * une nuit ?"). `url` is always hotels.booking_url, read straight from the
 * database row — never from the model, the RAG knowledge base, or the
 * visitor's message (see buildBookingAction in answer.ts). Only ever one
 * action type today ("booking"); the discriminated `type` field exists so a
 * future action kind doesn't require a breaking change to this shape.
 */
export interface ChatAction {
  type: "booking";
  label: string;
  url: string;
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
}
