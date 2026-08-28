// Shared body for BOTH chat routes — src/app/api/hotels/[id]/chat/route.ts
// (back-office) and src/app/api/client/hotels/[id]/chat/route.ts (client
// portal). Each route does its OWN scope-explicit requireHotelAccess(hotelId,
// scope) check first (never here — this function assumes the caller is
// already authorized) and then calls handleHotelChatRequest with the exact
// same hotelId. This is what lets ChatPreview.tsx stay a single component
// serving both the admin "Mode test" panel and "Tester mon chatbot", without
// this module itself ever having to know or guess which space called it.
//
// Every Supabase operation below uses the SERVICE-ROLE client, not a
// session-bound one — structurally identical to /api/widget/[widgetKey]/chat/route.ts:
// authorize once at the edge (in each route.ts), then let the RAG pipeline
// run with service_role. This is deliberate, not incidental: it means
// neither a hotel_admin's client-portal session nor a superadmin's
// back-office session ever has (or needs) direct RLS-based read access to
// knowledge_sources/knowledge_chunks/message_sources — those stay reachable
// exclusively through this server-mediated path. service_role already holds
// every grant this needs from 0009_widget_service_role_permissions.sql
// (hotels, chatbot_settings, accommodation_types, knowledge_chunks,
// knowledge_sources SELECT; conversations/messages SELECT/INSERT/UPDATE;
// message_sources INSERT; match_knowledge_chunks EXECUTE) plus
// match_knowledge_chunks_hybrid EXECUTE from 0013_hybrid_retrieval.sql.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { answerQuestion } from "@/features/rag/answer";

const chatRequestSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1, "Le message est vide."),
});

export async function handleHotelChatRequest(request: Request, hotelId: string): Promise<NextResponse> {
  const parsed = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const { message } = parsed.data;
  const requestedConversationId = parsed.data.conversationId ?? null;

  const supabase = createAdminClient();

  const { data: hotel, error: hotelError } = await supabase.from("hotels").select("id").eq("id", hotelId).maybeSingle();
  if (hotelError || !hotel) {
    return NextResponse.json({ error: "Établissement introuvable." }, { status: 404 });
  }

  let conversationId: string;
  if (requestedConversationId) {
    const { data: conversation, error: convError } = await supabase
      .from("conversations")
      .select("id, hotel_id")
      .eq("id", requestedConversationId)
      .maybeSingle();
    if (convError || !conversation || conversation.hotel_id !== hotelId) {
      return NextResponse.json({ error: "Conversation introuvable pour cet établissement." }, { status: 404 });
    }
    conversationId = conversation.id;
  } else {
    const { data: created, error: createError } = await supabase
      .from("conversations")
      .insert({ hotel_id: hotelId, session_id: `admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}` })
      .select("id")
      .single();
    if (createError || !created) {
      console.error("handleHotelChatRequest: failed to create conversation", { hotelId, message: createError?.message });
      return NextResponse.json({ error: "Impossible de démarrer la conversation." }, { status: 500 });
    }
    conversationId = created.id;
  }

  try {
    const result = await answerQuestion({ hotelId, conversationId, message, supabase });
    return NextResponse.json({
      conversationId,
      reply: result.reply,
      sources: result.sources.map((s) => ({ sourceId: s.sourceId, sourceTitle: s.sourceTitle, similarity: s.similarity })),
      answerStatus: result.answerStatus,
      // roomRecommendation.bookingUrl and action are both already sourced
      // server-side from hotels.booking_url by answerQuestion() itself (see
      // buildRoomRecommendation / buildBookingAction in
      // features/rag/answer.ts) — nothing to add or override here anymore.
      roomRecommendation: result.roomRecommendation,
      action: result.action,
      // Each partner's action (partner_booking/partner_website) is already
      // sourced server-side from hotel_partners.booking_url/website_url by
      // answerQuestion() itself (see buildPartnerAction in
      // features/rag/partners.ts) — nothing to add or override here.
      partnerRecommendations: result.partnerRecommendations,
    });
  } catch (err) {
    console.error("handleHotelChatRequest: answerQuestion failed", { hotelId, message: (err as Error).message });
    return NextResponse.json({ error: "Une erreur est survenue. Veuillez réessayer." }, { status: 500 });
  }
}
