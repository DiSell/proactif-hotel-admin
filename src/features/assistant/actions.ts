"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { chatbotSettingsSchema } from "./schema";
import type { ActionResult } from "@/lib/actionResult";

export interface SaveAssistantSettingsInput {
  assistant_name: string;
  welcome_message: string;
  fallback_message: string;
  handoff_email: string;
  handoff_phone: string;
  tone: string;
  formality: string;
  response_length: string;
  commercial_proactivity: string;
  custom_instructions: string;
}

export async function saveAssistantSettings(
  hotelId: string,
  input: SaveAssistantSettingsInput
): Promise<ActionResult<null>> {
  await requireSuperadmin();

  if (!input.assistant_name.trim()) {
    return { ok: false, error: "Le nom de l’assistant est obligatoire.", fieldErrors: { assistant_name: "Obligatoire." } };
  }

  const parsed = chatbotSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { ok: false, error: "Certains champs sont invalides.", fieldErrors };
  }

  const supabase = await createClient();

  const { error: hotelError } = await supabase
    .from("hotels")
    .update({ assistant_name: input.assistant_name.trim() })
    .eq("id", hotelId);

  if (hotelError) {
    console.error("saveAssistantSettings: hotels update failed", { message: hotelError.message });
    return { ok: false, error: "Impossible d’enregistrer les modifications." };
  }

  const { error: settingsError } = await supabase.from("chatbot_settings").upsert(
    {
      hotel_id: hotelId,
      welcome_message: parsed.data.welcome_message,
      fallback_message: parsed.data.fallback_message,
      handoff_email: parsed.data.handoff_email || null,
      handoff_phone: parsed.data.handoff_phone || null,
      tone: parsed.data.tone,
      formality: parsed.data.formality,
      response_length: parsed.data.response_length,
      commercial_proactivity: parsed.data.commercial_proactivity,
      custom_instructions: parsed.data.custom_instructions || null,
    },
    { onConflict: "hotel_id" }
  );

  if (settingsError) {
    console.error("saveAssistantSettings: chatbot_settings upsert failed", { message: settingsError.message });
    return { ok: false, error: "Impossible d’enregistrer les modifications." };
  }

  revalidatePath(`/etablissements/${hotelId}`);
  revalidatePath(`/etablissements/${hotelId}/assistant`);
  return { ok: true, data: null };
}
