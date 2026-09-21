import type { AuthScope } from "@/lib/supabase/cookieScope";
import { requireHotelAccess } from "@/lib/auth/session";
import { serviceHotelSchema, serviceRequestIdentitySchema } from "./schema";
import type { HotelServiceRequest, HotelServiceRoute, ServiceRequestEvent } from "./types";

// No public widget integration. Reads authorize here and use the returned
// session-bound client (RLS), never a service-role fallback.
const REQUEST_COLUMNS = "id, hotel_id, conversation_id, kind, category, priority, status, guest_message, location, assigned_route_id, created_at, updated_at, acknowledged_at, resolved_at";
const ROUTE_COLUMNS = "id, hotel_id, category, label, phone_e164, is_active, created_at, updated_at";
const EVENT_COLUMNS = "id, event_sequence, hotel_id, service_request_id, event_type, actor_type, actor_user_id, from_status, to_status, message, location, assigned_route_id, category, created_at";

export async function getServiceRequest(hotelId: string, requestId: string, scope: AuthScope): Promise<HotelServiceRequest | null> {
  serviceRequestIdentitySchema.parse({ hotelId, requestId });
  const { supabase } = await requireHotelAccess(hotelId, scope);
  const { data, error } = await supabase.from("hotel_service_requests").select(REQUEST_COLUMNS)
    .eq("hotel_id", hotelId).eq("id", requestId).maybeSingle<HotelServiceRequest>();
  if (error) throw new Error("Impossible de charger la demande.");
  return data;
}

export async function listServiceRequests(hotelId: string, scope: AuthScope): Promise<HotelServiceRequest[]> {
  serviceHotelSchema.parse(hotelId);
  const { supabase } = await requireHotelAccess(hotelId, scope);
  const { data, error } = await supabase.from("hotel_service_requests").select(REQUEST_COLUMNS)
    .eq("hotel_id", hotelId).order("created_at", { ascending: false }).order("id").returns<HotelServiceRequest[]>();
  if (error) throw new Error("Impossible de charger les demandes.");
  return data ?? [];
}

export async function listServiceRoutes(hotelId: string, scope: AuthScope): Promise<HotelServiceRoute[]> {
  serviceHotelSchema.parse(hotelId);
  const { supabase } = await requireHotelAccess(hotelId, scope);
  const { data, error } = await supabase.from("hotel_service_routes").select(ROUTE_COLUMNS)
    .eq("hotel_id", hotelId).order("category").returns<HotelServiceRoute[]>();
  if (error) throw new Error("Impossible de charger les destinataires.");
  return data ?? [];
}

export async function listServiceRequestEvents(hotelId: string, requestId: string, scope: AuthScope): Promise<ServiceRequestEvent[]> {
  serviceRequestIdentitySchema.parse({ hotelId, requestId });
  const { supabase } = await requireHotelAccess(hotelId, scope);
  const { data, error } = await supabase.from("hotel_service_request_events").select(EVENT_COLUMNS)
    .eq("hotel_id", hotelId).eq("service_request_id", requestId)
    .order("event_sequence").returns<ServiceRequestEvent[]>();
  if (error) throw new Error("Impossible de charger l'historique.");
  return data ?? [];
}
