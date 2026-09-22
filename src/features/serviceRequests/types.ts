export const SERVICE_REQUEST_KINDS = ["incident", "handover"] as const;
export const SERVICE_REQUEST_CATEGORIES = ["technical", "reception", "billing", "internal_alert"] as const;
export const SERVICE_REQUEST_PRIORITIES = ["normal", "priority", "urgent"] as const;
export const SERVICE_REQUEST_STATUSES = ["awaiting_guest_info", "open", "acknowledged", "resolved", "cancelled"] as const;

export type ServiceRequestKind = (typeof SERVICE_REQUEST_KINDS)[number];
export type ServiceRequestCategory = (typeof SERVICE_REQUEST_CATEGORIES)[number];
export type ServiceRequestPriority = (typeof SERVICE_REQUEST_PRIORITIES)[number];
export type ServiceRequestStatus = (typeof SERVICE_REQUEST_STATUSES)[number];
export type ServiceRequestEventType = "created" | "guest_info_updated" | "opened" | "assigned" | "acknowledged" | "resolved" | "cancelled";

export interface HotelServiceRoute {
  id: string;
  hotel_id: string;
  category: ServiceRequestCategory;
  label: string;
  /** Private operational contact: only authorized hotel management reads this. */
  phone_e164: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface HotelServiceRequest {
  id: string;
  hotel_id: string;
  conversation_id: string | null;
  kind: ServiceRequestKind;
  category: ServiceRequestCategory;
  priority: ServiceRequestPriority;
  status: ServiceRequestStatus;
  guest_message: string;
  location: string | null;
  assigned_route_id: string | null;
  /**
   * HUMAN HANDOVER / RAPPEL SMS chantier (0048, NOT YET APPLIED) — set only
   * for a guest-created 'handover' request (see
   * features/rag/humanHandoverFlow.ts and the guest-safe
   * create_hotel_service_request_from_widget RPC); null for every
   * staff-created request via 0043's own create_hotel_service_request.
   */
  guest_phone_e164: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

export interface ServiceRequestEvent {
  id: string;
  event_sequence: number;
  hotel_id: string;
  service_request_id: string;
  event_type: ServiceRequestEventType;
  /** Phase 1 RPCs only produce hotel_user, inferred from the authenticated session. */
  actor_type: "system" | "guest" | "hotel_user";
  actor_user_id: string | null;
  from_status: ServiceRequestStatus | null;
  to_status: ServiceRequestStatus;
  message: string | null;
  location: string | null;
  assigned_route_id: string | null;
  category: ServiceRequestCategory;
  created_at: string;
}
