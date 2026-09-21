"use server";

import { requireHotelAccess } from "@/lib/auth/session";
import type { AuthScope } from "@/lib/supabase/cookieScope";
import type { ActionResult } from "@/lib/actionResult";
import {
  createServiceRequestSchema, serviceRequestCommandSchema, saveServiceRouteSchema,
  type CreateServiceRequestInput, type ServiceRequestCommandInput, type SaveServiceRouteInput,
} from "./schema";

async function createInternal(input: CreateServiceRequestInput, scope: AuthScope): Promise<ActionResult<{ id: string }>> {
  const parsed = createServiceRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides." };
  const value = parsed.data;
  const { supabase } = await requireHotelAccess(value.hotelId, scope);
  const { data, error } = await supabase.rpc("create_hotel_service_request", {
    p_hotel_id: value.hotelId, p_conversation_id: value.conversationId ?? null,
    p_kind: value.kind, p_category: value.category, p_priority: value.priority,
    p_guest_message: value.guestMessage, p_location: value.location ?? null,
    p_assigned_route_id: value.assignedRouteId ?? null, p_awaiting_guest_info: value.awaitingGuestInfo,
  });
  // Never surface/log raw database errors: constraint details can contain PII.
  if (error) return { ok: false, error: "Impossible de créer la demande." };
  return { ok: true, data: { id: data as string } };
}

async function commandInternal(input: ServiceRequestCommandInput, scope: AuthScope): Promise<ActionResult<null>> {
  const parsed = serviceRequestCommandSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Commande invalide." };
  const value = parsed.data;
  const { supabase } = await requireHotelAccess(value.hotelId, scope);
  const { error } = await supabase.rpc("apply_hotel_service_request_command", {
    p_hotel_id: value.hotelId, p_request_id: value.requestId, p_command: value.command,
    p_guest_message: value.command === "update_guest_info" ? value.guestMessage : null,
    p_location: value.command === "update_guest_info" ? value.location : null,
    p_route_id: value.command === "assign" ? value.routeId : null,
  });
  if (error) return { ok: false, error: "Impossible d'appliquer cette action." };
  return { ok: true, data: null };
}

async function saveRouteInternal(input: SaveServiceRouteInput, scope: AuthScope): Promise<ActionResult<{ id: string }>> {
  const parsed = saveServiceRouteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Destinataire invalide." };
  const value = parsed.data;
  const { supabase } = await requireHotelAccess(value.hotelId, scope);
  const { data, error } = await supabase.rpc("save_hotel_service_route", {
    p_hotel_id: value.hotelId, p_route_id: value.routeId ?? null, p_category: value.category,
    p_label: value.label, p_phone_e164: value.phoneE164, p_is_active: value.isActive,
  });
  if (error) return { ok: false, error: "Impossible d'enregistrer le destinataire." };
  return { ok: true, data: { id: data as string } };
}

// Cookie scope is fixed at every public Server Action boundary, never caller selected.
export async function createServiceRequestClient(input: CreateServiceRequestInput) {
  return createInternal(input, "client");
}
export async function createServiceRequestBackoffice(input: CreateServiceRequestInput) {
  return createInternal(input, "backoffice");
}
export async function applyServiceRequestCommandClient(input: ServiceRequestCommandInput) {
  return commandInternal(input, "client");
}
export async function applyServiceRequestCommandBackoffice(input: ServiceRequestCommandInput) {
  return commandInternal(input, "backoffice");
}
export async function saveServiceRouteClient(input: SaveServiceRouteInput) {
  return saveRouteInternal(input, "client");
}
export async function saveServiceRouteBackoffice(input: SaveServiceRouteInput) {
  return saveRouteInternal(input, "backoffice");
}
