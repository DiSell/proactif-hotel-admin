"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { widgetSettingsSchema, type WidgetSettingsInput } from "./schema";
import type { ActionResult } from "@/lib/actionResult";

export async function saveWidgetSettings(hotelId: string, input: WidgetSettingsInput): Promise<ActionResult<null>> {
  await requireSuperadmin();

  const parsed = widgetSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] = issue.message;
    return { ok: false, error: "Champs invalides.", fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("widget_settings")
    .upsert({ hotel_id: hotelId, ...parsed.data }, { onConflict: "hotel_id" });

  if (error) {
    console.error("saveWidgetSettings: supabase upsert failed", { message: error.message });
    return { ok: false, error: "Impossible d’enregistrer les modifications." };
  }

  revalidatePath(`/etablissements/${hotelId}/widget`);
  return { ok: true, data: null };
}
