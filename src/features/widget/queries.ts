import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import type { WidgetSettings } from "@/types/database";

async function fetchWidgetSettings(hotelId: string): Promise<WidgetSettings | null> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("widget_settings").select("*").eq("hotel_id", hotelId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export const getWidgetSettings = cache(fetchWidgetSettings);
