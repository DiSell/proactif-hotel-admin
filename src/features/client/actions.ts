"use server";

import { revalidatePath } from "next/cache";
import { requireClientAccess } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  allowPriceCommunicationSchema,
  clientChatbotPersonalizationSchema,
  photoManagementModeSchema,
  type ClientChatbotPersonalizationInput,
  type PhotoManagementMode,
} from "./schema";
import type { ActionResult } from "@/lib/actionResult";

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

/**
 * The ONLY write path for the client-facing "PERSONNALISATION" section of
 * /client/chatbot (assistant name + welcome message). hotelId is never
 * accepted as a parameter — always resolved from the caller's own session
 * via requireClientAccess(), so a hotel_admin can never target another
 * hotel no matter what a crafted request body contains.
 *
 * Writes hotels.assistant_name (reused, unchanged column) and
 * widget_settings.welcome_message — NOT chatbot_settings.welcome_message,
 * even though that field also exists and is what the read-only preview
 * used to display. See supabase/migrations/0014_chatbot_personalization.sql's
 * own comment for the full reasoning: widget_settings.welcome_message is
 * the one field src/features/widget/publicHotel.ts actually reads for the
 * live public widget, so writing here is what makes item 7 ("le message
 * affiché réellement dans le widget doit utiliser cette configuration")
 * true for real, not just in the admin's own preview.
 *
 * Uses the service_role client (createAdminClient()) after
 * requireClientAccess() has already authorized the caller — same
 * discipline as every other client-portal write in this codebase (see
 * features/hotelUsers/actions.ts). Upserts widget_settings: a hotel that
 * never visited the (superadmin) widget settings page has no row there yet
 * — see resolvePublicWidgetContext's own comment on why that's a normal,
 * defaults-carrying state, not an error.
 */
export async function updateChatbotPersonalization(input: ClientChatbotPersonalizationInput): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();

  const parsed = clientChatbotPersonalizationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const supabase = createAdminClient();

  const { error: hotelError } = await supabase
    .from("hotels")
    .update({ assistant_name: parsed.data.assistant_name })
    .eq("id", hotelId);
  if (hotelError) {
    console.error("updateChatbotPersonalization: hotels update failed", { message: hotelError.message });
    return { ok: false, error: "Impossible d’enregistrer le nom de l’assistant." };
  }

  const { data: existingWidgetSettings } = await supabase
    .from("widget_settings")
    .select("id")
    .eq("hotel_id", hotelId)
    .maybeSingle();

  const widgetSettingsError = existingWidgetSettings
    ? (await supabase.from("widget_settings").update({ welcome_message: parsed.data.welcome_message }).eq("hotel_id", hotelId)).error
    : (await supabase.from("widget_settings").insert({ hotel_id: hotelId, welcome_message: parsed.data.welcome_message })).error;

  if (widgetSettingsError) {
    console.error("updateChatbotPersonalization: widget_settings write failed", { message: widgetSettingsError.message });
    return { ok: false, error: "Impossible d’enregistrer le message d’accueil." };
  }

  revalidatePath("/client/chatbot");
  return { ok: true, data: null };
}

/**
 * Who manages the chatbot's photos day to day — see
 * supabase/migrations/0014_chatbot_personalization.sql. Deliberately
 * client-only (no superadmin equivalent action): "Le CLIENT HOTEL garde le
 * dernier mot sur ce qui apparaît dans son chatbot [...] Le superadmin
 * Proactif peut intervenir uniquement si le client lui délègue cette
 * gestion" — the delegation decision itself belongs to the client alone.
 */
export async function setPhotoManagementMode(mode: PhotoManagementMode): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();

  const parsed = photoManagementModeSchema.safeParse(mode);
  if (!parsed.success) return { ok: false, error: "Valeur invalide." };

  const supabase = createAdminClient();
  const { error } = await supabase.from("hotels").update({ photo_management: parsed.data }).eq("id", hotelId);
  if (error) {
    console.error("setPhotoManagementMode: hotels update failed", { message: error.message });
    return { ok: false, error: "Impossible d’enregistrer ce choix." };
  }

  revalidatePath("/client/photos");
  return { ok: true, data: null };
}

/**
 * The ONE chatbot_settings field a hotel_admin may write themselves — see
 * features/client/schema.ts:allowPriceCommunicationSchema's own doc comment
 * on why this is a dedicated, narrow action rather than a reuse of
 * saveAssistantSettings (features/assistant/actions.ts, requireSuperadmin,
 * the rest of chatbot_settings). hotelId is never accepted as a parameter —
 * same discipline as every other action in this file.
 *
 * chatbot_settings has NO hotel_admin UPDATE policy (only a read policy,
 * see 0011_hotel_client_portal.sql) — write access here comes from
 * createAdminClient() (service-role, bypasses RLS) AFTER
 * requireClientAccess() has already authorized the caller and the update
 * is explicitly scoped to their own hotel_id, exactly the same pattern
 * setPhotoManagementMode above already uses for `hotels`. No RLS policy is
 * added or changed by this action.
 *
 * service_role additionally needs its own GRANT for this write to succeed
 * against the real database — see
 * 0040_chatbot_settings_price_communication_service_role_grant.sql,
 * column-scoped to allow_price_communication only (same discipline as
 * hotel_partners' own column grants), never a broad `grant update` that
 * would put chatbot_settings' superadmin-only fields (tone,
 * custom_instructions, etc.) within reach of a future bug here. That
 * migration is additive and PROPOSED, mirroring 0039's own status.
 *
 * Plain UPDATE, not upsert: chatbot_settings.hotel_id is `not null unique`
 * and a row is seeded for every hotel at hotel-creation time
 * (features/hotels/actions.ts::createHotel's own insert) — unlike
 * widget_settings (only created lazily, the first time a hotel opens the
 * widget settings page), there is no "hotel with no chatbot_settings row
 * yet" case to upsert around here. UPDATE also matches the narrower
 * service_role grant above one-for-one — UPSERT would additionally require
 * an INSERT grant this action never needs in practice.
 */
export async function setAllowPriceCommunication(allow: boolean): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();

  const parsed = allowPriceCommunicationSchema.safeParse(allow);
  if (!parsed.success) return { ok: false, error: "Valeur invalide." };

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("chatbot_settings")
    .update({ allow_price_communication: parsed.data })
    .eq("hotel_id", hotelId);
  if (error) {
    console.error("setAllowPriceCommunication: chatbot_settings update failed", { message: error.message });
    return { ok: false, error: "Impossible d’enregistrer ce choix." };
  }

  revalidatePath("/client/chatbot");
  return { ok: true, data: null };
}

/**
 * Blocks/unblocks a visitor's ongoing widget session on ONE conversation —
 * see block_conversation()/unblock_conversation() (0036_conversation_moderation.sql)
 * and the widget chat route's own check on conversations.blocked_at. hotelId
 * is never accepted as a parameter, same discipline as every other action in
 * this file — always resolved from the caller's own session via
 * requireClientAccess(), so a hotel_admin can never target another hotel's
 * conversation no matter what a crafted request contains (the RPC itself
 * re-validates ownership server-side regardless, via is_hotel_admin_for).
 *
 * Session-scoped, not visitor-scoped (see moderation.ts/0036's own doc
 * comment): blocking targets this one conversation's own session_id — a
 * visitor who clears their browser storage gets a fresh, unblocked session.
 * An accepted, already-communicated limitation, not a gap specific to this
 * action.
 */
export async function blockConversationClient(conversationId: string): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();
  const supabase = createAdminClient();

  const { error } = await supabase.rpc("block_conversation", { p_hotel_id: hotelId, p_conversation_id: conversationId });
  if (error) {
    console.error("blockConversationClient: rpc failed", { message: error.message });
    return { ok: false, error: "Impossible de bloquer ce visiteur." };
  }

  revalidatePath(`/client/conversations/${conversationId}`);
  return { ok: true, data: null };
}

export async function unblockConversationClient(conversationId: string): Promise<ActionResult<null>> {
  const { hotelId } = await requireClientAccess();
  const supabase = createAdminClient();

  const { error } = await supabase.rpc("unblock_conversation", { p_hotel_id: hotelId, p_conversation_id: conversationId });
  if (error) {
    console.error("unblockConversationClient: rpc failed", { message: error.message });
    return { ok: false, error: "Impossible de débloquer ce visiteur." };
  }

  revalidatePath(`/client/conversations/${conversationId}`);
  return { ok: true, data: null };
}
