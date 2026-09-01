"use server";

import { revalidatePath } from "next/cache";
import { requireHotelAccess } from "@/lib/auth/session";
import { hotelEventSchema, type HotelEventInput } from "./schema";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";

/**
 * Every action here is guarded by requireHotelAccess(hotelId, scope) — same
 * discipline as features/partners/actions.ts. Only the "client" scope is
 * exported today (task: "on parle bien de l'espace de configuration du
 * client") — the *Internal functions already take `scope` as a plain
 * argument, so a future *Backoffice wrapper (an admin-side events UI) could
 * be added later as a one-line thin export, without touching any of the
 * logic below, if that ever becomes a real requirement. `scope` is NEVER a
 * parameter on any exported Server Action — never received from a client
 * component, always a hardcoded literal at the export itself.
 *
 * Writes through the SESSION-BOUND client returned by requireHotelAccess()
 * itself, not service_role — RLS (0032_hotel_events.sql) is the real gate,
 * identical reasoning to features/partners/actions.ts: a hotel event is a
 * small CRUD resource with no external side effect.
 */

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

function revalidateEventPaths() {
  revalidatePath("/client/chatbot");
}

function toRow(input: HotelEventInput) {
  return {
    type: input.type,
    title: input.title,
    content: input.content,
    starts_at: input.starts_at,
    ends_at: input.ends_at,
    is_active: input.is_active,
    show_as_banner: input.show_as_banner,
  };
}

async function createHotelEventInternal(hotelId: string, input: HotelEventInput, scope: AuthScope): Promise<ActionResult<{ id: string }>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const parsed = hotelEventSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const { data, error } = await supabase
    .from("hotel_events")
    .insert({ hotel_id: hotelId, ...toRow(parsed.data) })
    .select("id")
    .single();

  if (error || !data) {
    console.error("createHotelEvent: insert failed", { message: error?.message });
    return { ok: false, error: "Impossible de créer cet événement." };
  }

  revalidateEventPaths();
  return { ok: true, data: { id: data.id } };
}

export async function createHotelEventClient(hotelId: string, input: HotelEventInput): Promise<ActionResult<{ id: string }>> {
  return createHotelEventInternal(hotelId, input, "client");
}

async function updateHotelEventInternal(hotelId: string, eventId: string, input: HotelEventInput, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const parsed = hotelEventSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const { error } = await supabase.from("hotel_events").update(toRow(parsed.data)).eq("id", eventId).eq("hotel_id", hotelId);
  if (error) {
    console.error("updateHotelEvent: update failed", { message: error.message });
    return { ok: false, error: "Impossible de modifier cet événement." };
  }

  revalidateEventPaths();
  return { ok: true, data: null };
}

export async function updateHotelEventClient(hotelId: string, eventId: string, input: HotelEventInput): Promise<ActionResult<null>> {
  return updateHotelEventInternal(hotelId, eventId, input, "client");
}

/** The "[Activer]/[Désactiver]" row action — a narrower write than updateHotelEvent, never touches any other field. */
async function setHotelEventActiveInternal(hotelId: string, eventId: string, isActive: boolean, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const { error } = await supabase.from("hotel_events").update({ is_active: isActive }).eq("id", eventId).eq("hotel_id", hotelId);
  if (error) {
    console.error("setHotelEventActive: update failed", { message: error.message });
    return { ok: false, error: "Impossible de mettre à jour cet événement." };
  }

  revalidateEventPaths();
  return { ok: true, data: null };
}

export async function setHotelEventActiveClient(hotelId: string, eventId: string, isActive: boolean): Promise<ActionResult<null>> {
  return setHotelEventActiveInternal(hotelId, eventId, isActive, "client");
}

async function deleteHotelEventInternal(hotelId: string, eventId: string, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const { error } = await supabase.from("hotel_events").delete().eq("id", eventId).eq("hotel_id", hotelId);
  if (error) {
    console.error("deleteHotelEvent: delete failed", { message: error.message });
    return { ok: false, error: "Impossible de supprimer cet événement." };
  }

  revalidateEventPaths();
  return { ok: true, data: null };
}

export async function deleteHotelEventClient(hotelId: string, eventId: string): Promise<ActionResult<null>> {
  return deleteHotelEventInternal(hotelId, eventId, "client");
}
