import { describe, expect, it } from "vitest";
import { createServiceRequestSchema, saveServiceRouteSchema, serviceRequestCommandSchema, serviceRequestStatusSchema } from "./schema";

const hotelId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const valid = { hotelId, kind: "incident", category: "technical", priority: "normal", guestMessage: "Fuite", awaitingGuestInfo: false };

describe("service request input boundaries", () => {
  it.each(["204", "Appartement 12", "Piscine", "Couloir étage 2", "Parking"])("accepts free location %s and no conversation", (location) => {
    expect(createServiceRequestSchema.parse({ ...valid, location }).location).toBe(location);
  });
  it.each([
    { priority: "critical" }, { kind: "partner" }, { category: "restaurant" },
    { status: "resolved" }, { actorType: "system" }, { scope: "backoffice" },
    { guestMessage: " " }, { guestMessage: "x".repeat(2001) }, { location: "x".repeat(201) },
    { conversationId: "wrong" }, { assignedRouteId: "wrong" },
  ])("rejects invalid or privileged creation fields: %j", (fields) => {
    expect(createServiceRequestSchema.safeParse({ ...valid, ...fields }).success).toBe(false);
  });
  it.each(["sent", "failed", "unknown", "anything"])("rejects transport/unknown business status %s", (status) => {
    expect(serviceRequestStatusSchema.safeParse(status).success).toBe(false);
  });
  it.each(["normal", "priority", "urgent"])("stores priority %s without classification", (priority) => {
    expect(createServiceRequestSchema.parse({ ...valid, priority }).priority).toBe(priority);
  });
  it("accepts handover billing independently of kind incident", () => {
    expect(createServiceRequestSchema.safeParse({ ...valid, kind: "handover", category: "billing" }).success).toBe(true);
  });
  it.each([
    { command: "resolve", status: "open" }, { command: "sent" },
    { command: "assign" }, { command: "update_guest_info", guestMessage: "Information" },
    { command: "acknowledge", actorUserId: hotelId },
    { command: "resolve", routeId: hotelId },
  ])("rejects incomplete or forged command %j", (command) => {
    expect(serviceRequestCommandSchema.safeParse({ hotelId, requestId, ...command }).success).toBe(false);
  });
  it("accepts explicit information replacement and location removal", () => {
    expect(serviceRequestCommandSchema.safeParse({ hotelId, requestId, command: "update_guest_info", guestMessage: "Précision", location: null }).success).toBe(true);
  });
  it.each(["0612345678", "", "+00000000", "+33612345678 "])("rejects non-E164 route phone %s", (phoneE164) => {
    expect(saveServiceRouteSchema.safeParse({ hotelId, category: "technical", label: "Maintenance", phoneE164, isActive: true }).success).toBe(false);
  });
  it("allows a configured but inactive route", () => {
    expect(saveServiceRouteSchema.safeParse({ hotelId, category: "technical", label: "Maintenance", phoneE164: "+33612345678", isActive: false }).success).toBe(true);
  });
});
