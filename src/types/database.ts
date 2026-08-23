// Hand-written row types matching supabase/migrations/0001_init.sql.
// Kept intentionally simple (no generated Database<> generic) — the app
// queries a handful of tables directly and doesn't need the full
// Supabase-generated schema typing machinery for this milestone.

export type ProfileRole = "superadmin" | "hotel_admin";

export interface Profile {
  id: string;
  email: string;
  role: ProfileRole;
  created_at: string;
  updated_at: string;
}

export type HotelStatus = "draft" | "active" | "inactive";

export interface Hotel {
  id: string;
  name: string;
  slug: string;
  widget_key: string;
  website: string | null;
  logo_url: string | null;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  languages: string[];
  default_language: string | null;
  booking_url: string | null;
  spa_booking_url: string | null;
  assistant_name: string | null;
  assistant_enabled: boolean;
  status: HotelStatus;
  created_at: string;
  updated_at: string;
}

export type ChatbotTone = "professional" | "warm" | "elegant" | "direct";
export type ChatbotFormality = "vous" | "tu";
export type ChatbotResponseLength = "short" | "normal" | "detailed";
export type ChatbotCommercialProactivity = "disabled" | "discreet" | "proactive";

export interface ChatbotSettings {
  id: string;
  hotel_id: string;
  welcome_message: string | null;
  fallback_message: string | null;
  handoff_email: string | null;
  handoff_phone: string | null;
  tone: ChatbotTone;
  formality: ChatbotFormality;
  response_length: ChatbotResponseLength;
  commercial_proactivity: ChatbotCommercialProactivity;
  custom_instructions: string | null;
  created_at: string;
  updated_at: string;
}

export type WidgetPosition = "bottom-right" | "bottom-left" | "top-right" | "top-left";
export type WidgetIcon = "chat" | "help" | "message";

export interface WidgetSettings {
  id: string;
  hotel_id: string;
  position: WidgetPosition;
  icon: WidgetIcon;
  welcome_message: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type KnowledgeSourceType = "url" | "text" | "document" | "faq" | "internal_note";
export type KnowledgeSourceStatus = "pending" | "indexed" | "error" | "disabled";

export interface KnowledgeSource {
  id: string;
  hotel_id: string;
  type: KnowledgeSourceType;
  title: string;
  content: string | null;
  source_url: string | null;
  storage_path: string | null;
  file_size_bytes: number | null;
  mime_type: string | null;
  status: KnowledgeSourceStatus;
  is_active: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Mirrors supabase/migrations/0003_site_analysis_consent.sql — PROPOSED,
 * not yet applied. See features/knowledge/actions.ts. An append-mostly
 * audit log: revoked_at is the only field ever updated after insert, rows
 * are never deleted or overwritten across consent_version changes.
 */
export interface SiteAnalysisConsent {
  id: string;
  hotel_id: string;
  domain: string;
  consent_version: string;
  consent_text: string;
  confirmed_by: string;
  confirmed_at: string;
  revoked_at: string | null;
  created_at: string;
}

/**
 * Mirrors supabase/migrations/0004_accommodation_types.sql — PROPOSED, not
 * yet applied. Capacity fields are nullable and never guessed server-side:
 * a row reaches this table with max_guests set only after a human has
 * explicitly confirmed it in the crawler's curation UI (see
 * features/knowledge/actions.ts:saveAccommodationTypes). NULL means
 * "unknown", never "zero" or "unlimited".
 */
export interface AccommodationType {
  id: string;
  hotel_id: string;
  name: string;
  source_url: string | null;
  max_guests: number | null;
  max_adults: number | null;
  max_children: number | null;
  bed_summary: string | null;
  description: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Mirrors supabase/migrations/0004_accommodation_types.sql. Linked to
 * accommodation_types by a stable FK (accommodation_type_id), never by a
 * free-text name, so renaming an accommodation never orphans its photos.
 * content_hash (SHA-256 of the downloaded bytes) is the real dedup key —
 * source_image_url alone can't catch the same file reachable at two URLs.
 */
export interface RoomPhoto {
  id: string;
  hotel_id: string;
  accommodation_type_id: string;
  source_page_url: string | null;
  source_image_url: string;
  storage_path: string;
  photo_url: string;
  content_hash: string;
  alt_text: string | null;
  position: number;
  created_at: string;
}

/**
 * Mirrors supabase/migrations/0005_integrations_reservations.sql —
 * PROPOSED, not yet applied. See features/integrations/types.ts for the
 * matching application-level contracts (IntegrationCapability,
 * ReservationReadProvider/CreateProvider/ModifyProvider/CancelProvider) and
 * features/availability/resolver.ts (DatabaseAvailabilityProviderResolver).
 */
export type IntegrationCapability =
  | "availability"
  | "rates"
  | "booking_url"
  | "reservation_read"
  | "reservation_create"
  | "reservation_modify"
  | "reservation_cancel";

export type IntegrationType = "PMS" | "BOOKING_ENGINE" | "CHANNEL_MANAGER";
export type IntegrationStatus = "disconnected" | "configured" | "active" | "error";

/**
 * Unique per (hotel_id, provider, integration_type) — NOT per (hotel_id,
 * provider) alone, so the same provider brand can be connected twice for
 * two different roles (e.g. "mews" as both a PMS and a booking engine).
 */
export interface HotelIntegration {
  id: string;
  hotel_id: string;
  provider: string;
  integration_type: IntegrationType;
  status: IntegrationStatus;
  capabilities: IntegrationCapability[];
  configuration: Record<string, unknown>;
  credential_reference: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * No implicit fallback: a hotel with no row here for a given capability
 * simply doesn't have it, never a guessed integration.
 */
export interface HotelIntegrationCapabilityRoute {
  id: string;
  hotel_id: string;
  capability: IntegrationCapability;
  integration_id: string;
  priority: number;
  created_at: string;
}

/**
 * A given accommodation_type_id can have a different external id per
 * integration (PMS != booking engine != channel manager) — this table is
 * the mapping, never a single global id assumed to match everywhere.
 */
export interface AccommodationInventoryMapping {
  id: string;
  hotel_id: string;
  integration_id: string;
  accommodation_type_id: string;
  external_accommodation_id: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type BookingQuoteStatus = "active" | "consumed" | "expired" | "invalidated";

/**
 * Server-resolved snapshot of one offer — see
 * src/features/reservations/types.ts (ReservationQuoteSummary). `id` IS the
 * opaque `quoteRef` handed to the browser: a random uuid carrying no
 * meaning of its own. total_price mirrors Money.amount (kept as a string
 * here to avoid float rounding, same reasoning as Money in
 * features/availability/types.ts) even though the underlying column is
 * `numeric` — read it as a string, never coerce to a JS number.
 */
export interface BookingQuote {
  id: string;
  hotel_id: string;
  integration_id: string;
  accommodation_type_id: string;
  external_accommodation_id: string;
  provider_offer_id: string | null;
  check_in: string;
  check_out: string;
  adults: number;
  children_count: number;
  children_ages: number[] | null;
  rooms: number;
  total_price: string | null;
  currency: string | null;
  created_at: string;
  expires_at: string | null;
  status: BookingQuoteStatus;
}

export type ReservationOperationType = "create" | "modify" | "cancel";
export type ReservationOperationStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

/**
 * The atomic idempotency claim, mutable by design — the opposite of
 * ReservationAuditLog below. A row is claimed by INSERT (the unique index
 * on (hotel_id, integration_id, operation_type, idempotency_key) is the
 * actual lock: a concurrent duplicate INSERT fails instead of racing past a
 * SELECT-then-act check), then mutated as the operation progresses
 * (status/external_reservation_id/provider_reference/error_code/updated_at).
 * A UNKNOWN after create must never trigger a blind retry — it must be
 * reconciled (idempotency-native replay, external_reservation_id lookup, or
 * reservation_read/search) before this row's status is allowed to change
 * again. No code in this repo writes to this table yet (Phase C).
 */
export interface ReservationOperation {
  id: string;
  hotel_id: string;
  integration_id: string;
  operation_type: ReservationOperationType;
  idempotency_key: string;
  status: ReservationOperationStatus;
  quote_id: string | null;
  external_reservation_id: string | null;
  provider_reference: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export type ReservationAuditAction = "create" | "get" | "modify" | "cancel";

/**
 * Pure, append-only historical trail — distinct from ReservationOperation
 * above and never used to acquire idempotency (enforced at the Postgres
 * level by a BEFORE UPDATE trigger that rejects every column change after
 * insert, plus no UPDATE/DELETE grant to `authenticated` — see
 * supabase/migrations/0005_integrations_reservations.sql). Deliberately no
 * PII column (no name/email/phone) — only enough to trace what was
 * attempted.
 */
export interface ReservationAuditLog {
  id: string;
  hotel_id: string;
  integration_id: string;
  action: ReservationAuditAction;
  idempotency_key: string | null;
  external_reservation_id: string | null;
  status: string;
  error_code: string | null;
  created_at: string;
}

export type ConversationStatus = "open" | "resolved" | "escalated";

export interface Conversation {
  id: string;
  hotel_id: string;
  session_id: string;
  language: string | null;
  status: ConversationStatus;
  visitor_name: string | null;
  visitor_email: string | null;
  visitor_phone: string | null;
  gdpr_consent: boolean;
  gdpr_consent_at: string | null;
  started_at: string;
  last_message_at: string | null;
}

export type MessageRole = "user" | "assistant" | "system";
export type AnswerStatus = "answered" | "fallback" | "error" | "handoff";

export interface Message {
  id: string;
  hotel_id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  // Populated for assistant messages only (Jalon 2 — RAG engine).
  answer_status: AnswerStatus | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  embedding_tokens: number | null;
  latency_ms: number | null;
  created_at: string;
}

// ---------------------------------------------------------------------
// Jalon 2 — RAG engine
// ---------------------------------------------------------------------

export interface KnowledgeChunk {
  id: string;
  hotel_id: string;
  source_id: string;
  content: string;
  chunk_index: number;
  token_count: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  // `embedding` (vector(1536)) is intentionally not modeled here — the app
  // never reads it back as a JS array, only writes it and lets Postgres
  // compare it via match_knowledge_chunks().
}

export interface MessageSource {
  id: string;
  message_id: string;
  hotel_id: string;
  source_id: string;
  chunk_id: string;
  similarity_score: number;
  created_at: string;
}

/** Row shape returned by the match_knowledge_chunks() RPC. */
export interface MatchedChunk {
  chunk_id: string;
  source_id: string;
  source_title: string;
  content: string;
  similarity: number;
}
