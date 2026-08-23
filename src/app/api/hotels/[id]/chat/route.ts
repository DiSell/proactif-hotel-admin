// Production chat route — powers the admin "Mode test" panel (ChatPreview)
// ONLY. Gated with requireSuperadmin() like every other admin surface. The
// future public widget will need its own route with its own (non-admin)
// auth model — this one is not meant to be reused for that.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperadmin } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { answerQuestion } from "@/features/rag/answer";

const chatRequestSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1, "Le message est vide."),
});

export async function POST(request: Request, context: RouteContext<"/api/hotels/[id]/chat">) {
  await requireSuperadmin();
  const { id: hotelId } = await context.params;

  const parsed = chatRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Requête invalide." }, { status: 400 });
  }
  const { message } = parsed.data;
  const requestedConversationId = parsed.data.conversationId ?? null;

  const supabase = await createClient();

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
      console.error("POST /api/hotels/[id]/chat: failed to create conversation", { hotelId, message: createError?.message });
      return NextResponse.json({ error: "Impossible de démarrer la conversation." }, { status: 500 });
    }
    conversationId = created.id;
  }

  try {
    const result = await answerQuestion({ hotelId, conversationId, message });
    return NextResponse.json({
      conversationId,
      reply: result.reply,
      sources: result.sources.map((s) => ({ sourceId: s.sourceId, sourceTitle: s.sourceTitle, similarity: s.similarity })),
      answerStatus: result.answerStatus,
      // roomRecommendation.bookingUrl is already sourced server-side from
      // hotels.booking_url by answerQuestion() itself (see
      // buildRoomRecommendation in features/rag/answer.ts) — nothing to add
      // or override here anymore.
      roomRecommendation: result.roomRecommendation,
    });
  } catch (err) {
    console.error("POST /api/hotels/[id]/chat: answerQuestion failed", { hotelId, message: (err as Error).message });
    return NextResponse.json({ error: "Une erreur est survenue. Veuillez réessayer." }, { status: 500 });
  }
}
