"use server";

import { revalidatePath } from "next/cache";
import { requireHotelAccess } from "@/lib/auth/session";
import { hotelSpaSettingsSchema, type HotelSpaSettingsInput } from "./schema";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";

/**
 * Same discipline as features/events/actions.ts: only the "client" scope is
 * exported (no back-office spa-settings UI was requested) — the *Internal
 * functions already take `scope` as a plain argument, so a future
 * *Backoffice wrapper could be added later as a one-line thin export.
 * `scope` is NEVER a parameter on any exported Server Action.
 *
 * Settings writes go through the SESSION-BOUND client returned by
 * requireHotelAccess() itself, not service_role — RLS
 * (0033_hotel_spa_settings.sql) is the real gate, same reasoning as
 * hotel_events (low-risk config data, no real business rule to enforce
 * beyond the shape checked by hotelSpaSettingsSchema). Booking cancellation,
 * by contrast, calls the cancel_spa_booking() SECURITY DEFINER RPC — that
 * table has no direct-write policy for anyone (0034_spa_bookings.sql).
 */

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

function revalidateSpaPaths() {
  revalidatePath("/client/chatbot");
}

function toRow(input: HotelSpaSettingsInput) {
  return {
    enabled: input.enabled,
    opens_at: input.opens_at,
    closes_at: input.closes_at,
    slot_duration_minutes: input.slot_duration_minutes,
    capacity_per_slot: input.capacity_per_slot,
    price_per_person: input.price_per_person,
    allow_non_residents: input.allow_non_residents,
    advance_booking_days: input.advance_booking_days,
    min_notice_hours: input.min_notice_hours,
    approval_mode: input.approval_mode,
    whatsapp_admin_phone_e164: input.whatsapp_admin_phone_e164,
  };
}

/**
 * Single row per hotel (hotel_id unique — 0033_hotel_spa_settings.sql) —
 * upsert on hotel_id rather than the create/update/delete trio
 * features/events/actions.ts exposes for its own multi-row resource.
 */
async function upsertHotelSpaSettingsInternal(hotelId: string, input: HotelSpaSettingsInput, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const parsed = hotelSpaSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  }

  const { error } = await supabase.from("hotel_spa_settings").upsert({ hotel_id: hotelId, ...toRow(parsed.data) }, { onConflict: "hotel_id" });
  if (error) {
    console.error("upsertHotelSpaSettings: upsert failed", { message: error.message });
    return { ok: false, error: "Impossible d'enregistrer la configuration." };
  }

  revalidateSpaPaths();
  return { ok: true, data: null };
}

export async function upsertHotelSpaSettingsClient(hotelId: string, input: HotelSpaSettingsInput): Promise<ActionResult<null>> {
  return upsertHotelSpaSettingsInternal(hotelId, input, "client");
}

async function cancelSpaBookingInternal(hotelId: string, bookingId: string, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const { error } = await supabase.rpc("cancel_spa_booking", {
    p_hotel_id: hotelId,
    p_booking_id: bookingId,
    p_cancelled_by: "hotel",
  });
  if (error) {
    console.error("cancelSpaBooking: rpc failed", { message: error.message });
    return { ok: false, error: "Impossible d'annuler cette réservation." };
  }

  revalidateSpaPaths();
  return { ok: true, data: null };
}

export async function cancelSpaBookingClient(hotelId: string, bookingId: string): Promise<ActionResult<null>> {
  return cancelSpaBookingInternal(hotelId, bookingId, "client");
}

/** The client-portal counterpart to cancelSpaBookingClient — the UI fallback for approving a pending_approval booking, always available regardless of whether WhatsApp itself is configured/working (0035_spa_booking_approval.sql). */
async function approveSpaBookingInternal(hotelId: string, bookingId: string, scope: AuthScope): Promise<ActionResult<null>> {
  const { supabase } = await requireHotelAccess(hotelId, scope);

  const { error } = await supabase.rpc("approve_spa_booking", {
    p_hotel_id: hotelId,
    p_booking_id: bookingId,
  });
  if (error) {
    console.error("approveSpaBooking: rpc failed", { message: error.message });
    return { ok: false, error: "Impossible de confirmer cette réservation." };
  }

  revalidateSpaPaths();
  return { ok: true, data: null };
}

export async function approveSpaBookingClient(hotelId: string, bookingId: string): Promise<ActionResult<null>> {
  return approveSpaBookingInternal(hotelId, bookingId, "client");
}
