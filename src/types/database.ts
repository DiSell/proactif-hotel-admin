// Hand-written row types matching supabase/migrations/0001_init.sql.
// Kept intentionally simple (no generated Database<> generic) — the app
// queries a handful of tables directly and doesn't need the full
// Supabase-generated schema typing machinery for this milestone.

export type ProfileRole = "superadmin" | "hotel_admin";

export interface Profile {
  id: string;
  email: string;
  role: ProfileRole;
  /** Mirrors supabase/migrations/0011_hotel_client_portal.sql — PROPOSED, not yet applied. Nullable: existing superadmin rows are never backfilled. */
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Mirrors supabase/migrations/0011_hotel_client_portal.sql — PROPOSED, not
 * yet applied. The ONLY place a user is linked to a hotel. MVP: at most one
 * row per user_id (hotel_users_user_key, a DB-level constraint, not just an
 * application convention) — one hotel per client account. A hotel can still
 * have several users later without a schema change.
 */
export interface HotelUser {
  id: string;
  hotel_id: string;
  user_id: string;
  created_at: string;
}

export type HotelStatus = "draft" | "active" | "inactive";

export type BookingActionMode = "url" | "host_widget";

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
  /** Mirrors supabase/migrations/0010_host_booking_action.sql — PROPOSED, not yet applied. Defaults to "url" (existing behavior). */
  booking_action_mode: BookingActionMode;
  /**
   * Raw jsonb — NEVER trusted as already-validated just because it came
   * from the database. Only ever consumed through
   * features/hotels/hostBookingTrigger.ts's parseHostBookingTrigger, which
   * returns null for anything that doesn't match the closed
   * {strategy:"click", selector} shape.
   */
  host_booking_trigger: unknown | null;
  assistant_name: string | null;
  assistant_enabled: boolean;
  /**
   * Mirrors supabase/migrations/0014_chatbot_personalization.sql —
   * PROPOSED, not yet applied. "Je gère mes photos" (client) vs "Je délègue
   * la gestion à Proactif System" (proactif) — see
   * features/client/actions.ts:setPhotoManagementMode. Defaults to
   * 'client': the client keeps the final say unless they explicitly
   * delegate it.
   */
  photo_management: "client" | "proactif";
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
  /**
   * Mirrors supabase/migrations/0014_chatbot_personalization.sql —
   * PROPOSED, not yet applied. Whether this photo is actually shown in the
   * chatbot — decoupled from "was this photo detected/imported at all".
   * Defaults to true (existing rows, created before this column existed,
   * keep behaving exactly as before). The client — or the superadmin
   * curating on their behalf when photo_management = 'proactif' — is the
   * only one who changes this after import; see features/photos/actions.ts.
   */
  is_selected: boolean;
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

export type HotelPartnerCategory =
  | "restaurant"
  | "transport"
  | "activity"
  | "wellness"
  | "shopping"
  | "local_product"
  | "guide"
  | "rental"
  | "other";

export type HotelPartnerConsentStatus = "not_requested" | "pending" | "accepted" | "declined";

/**
 * Mirrors supabase/migrations/0015_hotel_partners.sql (+ 0016_rag_freshness.sql's
 * unrelated columns elsewhere, + 0017_hotel_partner_consent.sql) — PROPOSED,
 * not yet applied. A local partner (restaurant, taxi, activity, ...) the
 * hotel itself chose and validated — never invented, never a "fake
 * accommodation" (independent of accommodation_types/room_photos/
 * knowledge_sources — see features/rag/partners.ts). is_active AND
 * consent_status === "accepted" BOTH gate whether the chatbot may ever
 * recommend it (features/rag/partners.ts::loadActiveHotelPartners) —
 * independent switches: the hotel's own on/off toggle, and the partner's
 * own confirmation. priority (higher first) then name (A-Z) is the sole
 * ordering rule — see rankPartnerCandidates.
 */
export interface HotelPartner {
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
  email: string | null;
  /**
   * PII (operational contact number) — 0020_partner_requests.sql. Distinct
   * from `phone` above (public-facing, may be shown to visitors):
   * server-resolved only, for the future WhatsApp-request routing layer.
   * Never expose via a public/chatbot-facing projection — see
   * features/partners/queries.ts's own PARTNER_COLUMNS doc comment and
   * features/rag/partners.ts, which must never read this field.
   */
  request_phone_e164: string | null;
  consent_status: HotelPartnerConsentStatus;
  consent_requested_at: string | null;
  consent_responded_at: string | null;
  /**
   * Independent from consent_status above — 0022_partner_transactional_consent.sql.
   * consent_status governs ONLY chatbot-recommendation eligibility;
   * whatsapp_consent_status governs whether this partner may LATER receive
   * a transactional WhatsApp request (features/partners/canReceivePartnerRequests.ts).
   * Accepting one is never interpreted as accepting the other — no
   * migration ever backfills this to "accepted" for an existing row.
   * whatsapp_consent_token_hash is deliberately NOT declared here, same
   * discipline as consent_token_hash: it must never reach a Client
   * Component even as a hash.
   */
  whatsapp_consent_status: HotelPartnerConsentStatus;
  whatsapp_consent_requested_at: string | null;
  whatsapp_consent_responded_at: string | null;
  is_active: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

export type HotelEventType = "permanent" | "temporary";

/**
 * A per-hotel fact the chatbot should know and use in its answers —
 * curated entirely by the hotel, never invented by the chatbot itself (same
 * "hotel is the source of truth" discipline as HotelPartner above). Two
 * kinds, distinguished by `type`:
 *   - "permanent": no expiry concept at all — starts_at/ends_at are always
 *     null (0032_hotel_events.sql's own CHECK constraint enforces this),
 *     stays relevant until the hotel deactivates/edits/deletes it.
 *   - "temporary": starts_at/ends_at are both required, ends_at >= starts_at.
 *     Deliberately available to the chatbot's PROMPT CONTEXT even before
 *     starts_at (a visitor can ask about a future date) — only excluded
 *     once ends_at is in the past. See features/rag/events.ts::loadActiveHotelEvents
 *     for the exact selection query this backs, and
 *     features/rag/prompt.ts::buildEventsGuidance for how it's presented to
 *     the model as DATA, never as an instruction.
 *
 * show_as_banner is a SEPARATE, narrower gate than "available to the
 * prompt" — see features/rag/events.ts::loadActiveBanner: only true while
 * the current date falls strictly within [starts_at, ends_at], never before
 * starts_at (0032's own CHECK constraint additionally forbids
 * show_as_banner on a "permanent" row — a banner needs a period to disappear
 * after).
 */
export interface HotelEvent {
  id: string;
  hotel_id: string;
  type: HotelEventType;
  title: string;
  content: string;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  show_as_banner: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Per-hotel spa-booking configuration — at most one row per hotel
 * (0033_hotel_spa_settings.sql, hotel_id unique). `enabled = false` (the
 * default) or a missing row both mean "this hotel does not offer spa
 * booking" — every reader in features/spa/ and features/rag/ treats them
 * identically, never distinguishing "never configured" from "configured but
 * turned off". `slot_duration_minutes` is the SINGLE source of truth for how
 * long a slot lasts — never hardcode a duration (e.g. 120) anywhere else;
 * every slot boundary/label is always derived from this column.
 */
export interface HotelSpaSettings {
  id: string;
  hotel_id: string;
  enabled: boolean;
  /** "HH:MM:SS" (Postgres `time`). */
  opens_at: string;
  closes_at: string;
  slot_duration_minutes: number;
  capacity_per_slot: number;
  price_per_person: number | null;
  allow_non_residents: boolean;
  advance_booking_days: number;
  min_notice_hours: number;
  created_at: string;
  updated_at: string;
}

export type SpaBookingStatus = "confirmed" | "cancelled";
export type SpaBookingCancelledBy = "guest" | "hotel" | "system";
export type SpaBookingNotificationStatus = "pending" | "sent" | "failed";

/**
 * A guest's spa reservation — created EXCLUSIVELY via the create_spa_booking()
 * SECURITY DEFINER RPC (0034_spa_bookings.sql), never a direct insert (see
 * features/spa/booking.ts). Auto-confirmed on creation (no accept/reject
 * negotiation, unlike hotel_partners' consent flow or partner_requests' state
 * machine) — the hotel is notified (owner_notification_status/owner_notified_at)
 * so staff can be present, not asked to approve. slot_end/price_per_person_snapshot
 * are frozen at booking time from hotel_spa_settings, so a later change to
 * the hotel's settings never retroactively alters an existing booking's
 * displayed price or duration.
 */
export interface SpaBooking {
  id: string;
  hotel_id: string;
  conversation_id: string;
  guest_name: string | null;
  guest_phone_e164: string | null;
  party_size: number;
  is_non_resident: boolean;
  notes: string | null;
  /** "YYYY-MM-DD" */
  booking_date: string;
  /** "HH:MM:SS" (Postgres `time`) */
  slot_start: string;
  slot_end: string;
  price_per_person_snapshot: number | null;
  status: SpaBookingStatus;
  cancelled_by: SpaBookingCancelledBy | null;
  cancelled_at: string | null;
  owner_notification_status: SpaBookingNotificationStatus;
  owner_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape returned by the match_knowledge_chunks() RPC. */
export interface MatchedChunk {
  chunk_id: string;
  source_id: string;
  source_title: string;
  content: string;
  similarity: number;
  /** knowledge_sources.source_url / last_synced_at — see 0016_rag_freshness.sql. */
  source_url: string | null;
  last_synced_at: string | null;
}

/** Row shape returned by the match_knowledge_chunks_hybrid() RPC (0013_hybrid_retrieval.sql, extended by 0016_rag_freshness.sql). */
export interface HybridMatchedChunk {
  chunk_id: string;
  source_id: string;
  source_title: string;
  content: string;
  vector_score: number;
  lexical_score: number;
  source_url: string | null;
  last_synced_at: string | null;
}
