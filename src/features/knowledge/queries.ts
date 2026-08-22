import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import type { KnowledgeSource } from "@/types/database";

export async function listKnowledgeSources(hotelId: string): Promise<KnowledgeSource[]> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("knowledge_sources")
    .select("*")
    .eq("hotel_id", hotelId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data ?? [];
}
