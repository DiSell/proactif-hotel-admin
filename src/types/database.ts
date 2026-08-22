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
