import { z } from "zod";
import { SERVICE_REQUEST_CATEGORIES, SERVICE_REQUEST_KINDS, SERVICE_REQUEST_PRIORITIES, SERVICE_REQUEST_STATUSES } from "./types";

export const serviceRequestStatusSchema = z.enum(SERVICE_REQUEST_STATUSES);
const messageSchema = z.string().trim().min(1).max(2000);
const locationSchema = z.string().trim().min(1).max(200).nullable();
const identity = { hotelId: z.string().uuid(), requestId: z.string().uuid() };

export const createServiceRequestSchema = z.object({
  hotelId: z.string().uuid(),
  conversationId: z.string().uuid().nullable().optional(),
  kind: z.enum(SERVICE_REQUEST_KINDS),
  category: z.enum(SERVICE_REQUEST_CATEGORIES),
  priority: z.enum(SERVICE_REQUEST_PRIORITIES),
  guestMessage: messageSchema,
  location: locationSchema.optional(),
  assignedRouteId: z.string().uuid().nullable().optional(),
  awaitingGuestInfo: z.boolean(),
}).strict();

// Commands, never an arbitrary target status or caller-selected actor.
export const serviceRequestCommandSchema = z.discriminatedUnion("command", [
  z.object({ ...identity, command: z.literal("open") }).strict(),
  z.object({ ...identity, command: z.literal("acknowledge") }).strict(),
  z.object({ ...identity, command: z.literal("resolve") }).strict(),
  z.object({ ...identity, command: z.literal("cancel") }).strict(),
  z.object({ ...identity, command: z.literal("assign"), routeId: z.string().uuid() }).strict(),
  // Full replacement of current information, with a snapshot in the event log.
  z.object({ ...identity, command: z.literal("update_guest_info"), guestMessage: messageSchema, location: locationSchema }).strict(),
]);

export const saveServiceRouteSchema = z.object({
  hotelId: z.string().uuid(),
  routeId: z.string().uuid().nullable().optional(),
  category: z.enum(SERVICE_REQUEST_CATEGORIES),
  label: z.string().trim().min(1).max(200),
  phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  isActive: z.boolean(),
}).strict();

export const serviceRequestIdentitySchema = z.object(identity).strict();
export const serviceHotelSchema = z.string().uuid();
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;
export type ServiceRequestCommandInput = z.infer<typeof serviceRequestCommandSchema>;
export type SaveServiceRouteInput = z.infer<typeof saveServiceRouteSchema>;
