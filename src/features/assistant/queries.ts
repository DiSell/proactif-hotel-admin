import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import type { ChatbotSettings } from "@/types/database";

async function fetchChatbotSettings(hotelId: string): Promise<ChatbotSettings | null> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("chatbot_settings").select("*").eq("hotel_id", hotelId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export const getChatbotSettings = cache(fetchChatbotSettings);
