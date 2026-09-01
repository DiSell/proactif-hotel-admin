import { createClientPortalClient } from "@/lib/supabase/server";
import { requireClientAccess } from "@/lib/auth/session";
import type { ChatbotSettings, Hotel, WidgetSettings } from "@/types/database";

/**
 * Every query in this module is session-bound (requireClientAccess() +
 * lib/supabase/server's createClientPortalClient()) — RLS (0011_hotel_client_portal.sql's
 * hotel_admin policies) is the real gate. The explicit `.eq("hotel_id",
 * hotelId)` filters below are defense in depth on top of that, matching the
 * same discipline used throughout this codebase (e.g. answer.ts's
 * conversations.update), not a substitute for RLS.
 */

export interface ConversationSummary {
  id: string;
  startedAt: string;
  lastMessageAt: string | null;
  messageCount: number;
  lastMessagePreview: string | null;
  /** Set once, the first time the model's own moderation self-report flags this conversation (0036_conversation_moderation.sql) — never cleared automatically. */
  flaggedAt: string | null;
  blockedAt: string | null;
}

async function summarizeConversations(
  supabase: Awaited<ReturnType<typeof createClientPortalClient>>,
  hotelId: string,
  conversations: { id: string; started_at: string; last_message_at: string | null; flagged_at: string | null; blocked_at: string | null }[]
): Promise<ConversationSummary[]> {
  if (conversations.length === 0) return [];
  const ids = conversations.map((c) => c.id);

  const { data: messages } = await supabase
    .from("messages")
    .select("conversation_id, content, created_at")
    .eq("hotel_id", hotelId)
    .in("conversation_id", ids)
    .order("created_at", { ascending: false });

  const countByConversation = new Map<string, number>();
  const lastMessageByConversation = new Map<string, string>();
  for (const message of messages ?? []) {
    countByConversation.set(message.conversation_id, (countByConversation.get(message.conversation_id) ?? 0) + 1);
    if (!lastMessageByConversation.has(message.conversation_id)) {
      lastMessageByConversation.set(message.conversation_id, message.content);
    }
  }

  return conversations.map((conversation) => ({
    id: conversation.id,
    startedAt: conversation.started_at,
    lastMessageAt: conversation.last_message_at,
    messageCount: countByConversation.get(conversation.id) ?? 0,
    lastMessagePreview: lastMessageByConversation.get(conversation.id) ?? null,
    flaggedAt: conversation.flagged_at,
    blockedAt: conversation.blocked_at,
  }));
}

export interface ClientDashboardData {
  hotelId: string;
  hotel: Hotel;
  chatbotSettings: ChatbotSettings | null;
  widgetSettings: WidgetSettings | null;
  totalConversations: number;
  totalMessages: number;
  conversations7d: number;
  conversations30d: number;
  recentConversations: ConversationSummary[];
}

export async function getClientDashboard(): Promise<ClientDashboardData> {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: hotel },
    { data: chatbotSettings },
    { data: widgetSettings },
    { count: totalConversations },
    { count: totalMessages },
    { count: conversations7d },
    { count: conversations30d },
    { data: recentRaw },
  ] = await Promise.all([
    supabase.from("hotels").select("*").eq("id", hotelId).single<Hotel>(),
    supabase.from("chatbot_settings").select("*").eq("hotel_id", hotelId).maybeSingle<ChatbotSettings>(),
    supabase.from("widget_settings").select("*").eq("hotel_id", hotelId).maybeSingle<WidgetSettings>(),
    supabase.from("conversations").select("*", { count: "exact", head: true }).eq("hotel_id", hotelId),
    supabase.from("messages").select("*", { count: "exact", head: true }).eq("hotel_id", hotelId),
    supabase.from("conversations").select("*", { count: "exact", head: true }).eq("hotel_id", hotelId).gte("started_at", sevenDaysAgo),
    supabase.from("conversations").select("*", { count: "exact", head: true }).eq("hotel_id", hotelId).gte("started_at", thirtyDaysAgo),
    supabase
      .from("conversations")
      .select("id, started_at, last_message_at, flagged_at, blocked_at")
      .eq("hotel_id", hotelId)
      .order("started_at", { ascending: false })
      .limit(5),
  ]);

  if (!hotel) throw new Error("getClientDashboard: hotel not found for an authorized hotelId — should never happen");

  const recentConversations = await summarizeConversations(supabase, hotelId, recentRaw ?? []);

  return {
    hotelId,
    hotel,
    chatbotSettings: chatbotSettings ?? null,
    widgetSettings: widgetSettings ?? null,
    totalConversations: totalConversations ?? 0,
    totalMessages: totalMessages ?? 0,
    conversations7d: conversations7d ?? 0,
    conversations30d: conversations30d ?? 0,
    recentConversations,
  };
}

const CONVERSATIONS_LIST_LIMIT = 50;

export async function getClientConversations(): Promise<{ hotelId: string; conversations: ConversationSummary[] }> {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("id, started_at, last_message_at, flagged_at, blocked_at")
    .eq("hotel_id", hotelId)
    .order("started_at", { ascending: false })
    .limit(CONVERSATIONS_LIST_LIMIT);
  if (error) throw new Error(error.message);

  return { hotelId, conversations: await summarizeConversations(supabase, hotelId, conversations ?? []) };
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

export interface ConversationDetail {
  id: string;
  startedAt: string;
  flaggedAt: string | null;
  flagReason: string | null;
  blockedAt: string | null;
  messages: ConversationMessage[];
}

/**
 * Returns null for a conversation that doesn't exist OR belongs to another
 * hotel — RLS already makes a foreign conversation invisible (same "known
 * UUID, still 404" property the public widget/chat routes rely on), the
 * explicit `.eq("hotel_id", hotelId)` here is defense in depth on top of
 * that, not the only thing standing between hotels.
 */
export async function getClientConversationDetail(conversationId: string): Promise<ConversationDetail | null> {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id, started_at, flagged_at, flag_reason, blocked_at")
    .eq("id", conversationId)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (conversationError) throw new Error(conversationError.message);
  if (!conversation) return null;

  const { data: messages, error: messagesError } = await supabase
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversationId)
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: true });
  if (messagesError) throw new Error(messagesError.message);

  return {
    id: conversation.id,
    startedAt: conversation.started_at,
    flaggedAt: conversation.flagged_at,
    flagReason: conversation.flag_reason,
    blockedAt: conversation.blocked_at,
    messages: (messages ?? []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at,
    })),
  };
}

export interface ClientChatbotData {
  hotelId: string;
  hotel: Hotel;
  chatbotSettings: ChatbotSettings | null;
}

/**
 * Deliberately does NOT read accommodation_types — no MVP portal page
 * needs it directly, and there is no hotel_admin RLS policy on that table
 * (see 0011_hotel_client_portal.sql's own comment: the chat test itself
 * needs accommodation_types internally for room ranking, but that read
 * happens server-side, through service_role, inside
 * /api/hotels/[id]/chat via requireHotelAccess — never through this
 * session-bound query).
 */
export async function getClientChatbotInfo(): Promise<ClientChatbotData> {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const [{ data: hotel }, { data: chatbotSettings }] = await Promise.all([
    supabase.from("hotels").select("*").eq("id", hotelId).single<Hotel>(),
    supabase.from("chatbot_settings").select("*").eq("hotel_id", hotelId).maybeSingle<ChatbotSettings>(),
  ]);

  if (!hotel) throw new Error("getClientChatbotInfo: hotel not found for an authorized hotelId — should never happen");

  return { hotelId, hotel, chatbotSettings: chatbotSettings ?? null };
}

export interface ClientWidgetData {
  hotelId: string;
  hotel: Hotel;
  widgetSettings: WidgetSettings | null;
}

export async function getClientWidgetInfo(): Promise<ClientWidgetData> {
  const { hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const [{ data: hotel }, { data: widgetSettings }] = await Promise.all([
    supabase.from("hotels").select("*").eq("id", hotelId).single<Hotel>(),
    supabase.from("widget_settings").select("*").eq("hotel_id", hotelId).maybeSingle<WidgetSettings>(),
  ]);

  if (!hotel) throw new Error("getClientWidgetInfo: hotel not found for an authorized hotelId — should never happen");

  return { hotelId, hotel, widgetSettings: widgetSettings ?? null };
}

export interface ClientAccountData {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  hotelName: string;
}

export async function getClientAccount(): Promise<ClientAccountData> {
  const { userId, profile, hotelId } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const { data: hotel } = await supabase.from("hotels").select("name").eq("id", hotelId).single<Pick<Hotel, "name">>();

  return {
    userId,
    firstName: profile.first_name,
    lastName: profile.last_name,
    email: profile.email,
    hotelName: hotel?.name ?? "—",
  };
}
