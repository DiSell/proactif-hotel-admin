import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "@/lib/email/sendEmail";
import { conversationFlaggedTemplate } from "@/lib/email/templates/conversationFlagged";
import { currentOrigin } from "@/lib/http/currentOrigin";

/**
 * Called from answer.ts (both answerGrounded and answerNoContext), ONCE per
 * turn, right after the model's structured output comes back — orthogonal to
 * every other flow (partner request, spa booking): a visitor can be
 * flagged mid-partner-request just as easily as mid-greeting.
 *
 * flag_conversation() (0036_conversation_moderation.sql) is idempotent —
 * only the FIRST flag on a given conversation actually changes anything and
 * returns true — so a notification email is sent at most once per
 * conversation, never once per abusive message in a sustained tirade.
 *
 * Best-effort, own try/catch: a moderation-flagging failure (RPC error,
 * email provider outage) must never surface as a chat-turn failure — the
 * visitor's reply has already been decided by the time this runs.
 */
export async function flagConversationForModeration(
  hotelId: string,
  conversationId: string,
  reason: string,
  supabase: SupabaseClient
): Promise<void> {
  try {
    const { data: isFirstFlag, error } = await supabase.rpc("flag_conversation", {
      p_hotel_id: hotelId,
      p_conversation_id: conversationId,
      p_reason: reason,
    });
    if (error) {
      console.error("flagConversationForModeration: rpc failed", { hotelId, conversationId, message: error.message });
      return;
    }
    if (!isFirstFlag) return;

    const [{ data: hotel }, { data: settings }] = await Promise.all([
      supabase.from("hotels").select("name, email").eq("id", hotelId).maybeSingle<{ name: string; email: string | null }>(),
      supabase.from("chatbot_settings").select("handoff_email").eq("hotel_id", hotelId).maybeSingle<{ handoff_email: string | null }>(),
    ]);

    const targetEmail = settings?.handoff_email || hotel?.email;
    if (!hotel || !targetEmail) return;

    const origin = await currentOrigin();
    const template = conversationFlaggedTemplate({
      hotelName: hotel.name,
      reason,
      conversationUrl: `${origin}/client/conversations/${conversationId}`,
    });
    await sendEmail({ to: targetEmail, subject: template.subject, html: template.html, text: template.text });
  } catch (err) {
    console.error("flagConversationForModeration: failed", { hotelId, conversationId, message: (err as Error).message });
  }
}
