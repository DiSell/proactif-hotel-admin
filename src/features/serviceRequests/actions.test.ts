import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateServiceRequestInput, ServiceRequestCommandInput } from "./schema";

const { authorize, rpc } = vi.hoisted(() => ({ authorize: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireHotelAccess: authorize }));
import {
  createServiceRequestClient, createServiceRequestBackoffice,
  applyServiceRequestCommandClient, applyServiceRequestCommandBackoffice,
  saveServiceRouteClient, saveServiceRouteBackoffice,
} from "./actions";

const hotelId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const input: CreateServiceRequestInput = { hotelId, kind: "incident", category: "technical", priority: "normal", guestMessage: "Fuite", awaitingGuestInfo: false };
beforeEach(() => {
  vi.resetAllMocks();
  authorize.mockResolvedValue({ supabase: { rpc } });
  rpc.mockResolvedValue({ data: requestId, error: null });
});

describe("authorized service request mutations", () => {
  it.each([[createServiceRequestClient, "client"], [createServiceRequestBackoffice, "backoffice"]] as const)("creates through the authorized session with fixed scope (%s, %s)", async (action, scope) => {
    expect(await action(input)).toEqual({ ok: true, data: { id: requestId } });
    expect(authorize).toHaveBeenCalledWith(hotelId, scope);
    expect(rpc).toHaveBeenCalledWith("create_hotel_service_request", {
      p_hotel_id: hotelId, p_conversation_id: null, p_kind: "incident", p_category: "technical",
      p_priority: "normal", p_guest_message: "Fuite", p_location: null,
      p_assigned_route_id: null, p_awaiting_guest_info: false,
    });
  });
  it("does not access DB if hotel authorization fails", async () => {
    authorize.mockRejectedValue(new Error("unauthorized hotel"));
    await expect(createServiceRequestClient(input)).rejects.toThrow("unauthorized hotel");
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["acknowledge", "resolve"] as const)("denies cross-hotel %s before RPC", async (command) => {
    authorize.mockRejectedValue(new Error("unauthorized hotel"));
    await expect(applyServiceRequestCommandClient({ hotelId, requestId, command })).rejects.toThrow("unauthorized hotel");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects forged status/actor fields before authorization", async () => {
    expect((await createServiceRequestClient({ ...input, status: "resolved" } as CreateServiceRequestInput)).ok).toBe(false);
    expect((await applyServiceRequestCommandClient({ hotelId, requestId, command: "resolve", actorType: "hotel_user" } as ServiceRequestCommandInput)).ok).toBe(false);
    expect(authorize).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([[applyServiceRequestCommandClient, "client"], [applyServiceRequestCommandBackoffice, "backoffice"]] as const)("uses fixed scope for commands (%s, %s)", async (action, scope) => {
    expect(await action({ hotelId, requestId, command: "acknowledge" })).toEqual({ ok: true, data: null });
    expect(authorize).toHaveBeenCalledWith(hotelId, scope);
    expect(rpc).toHaveBeenCalledWith("apply_hotel_service_request_command", {
      p_hotel_id: hotelId, p_request_id: requestId, p_command: "acknowledge", p_guest_message: null, p_location: null, p_route_id: null,
    });
  });
  it("sends information and assignment only with their corresponding commands", async () => {
    await applyServiceRequestCommandClient({ hotelId, requestId, command: "update_guest_info", guestMessage: "Fuite précisée", location: "Piscine" });
    expect(rpc).toHaveBeenLastCalledWith("apply_hotel_service_request_command", expect.objectContaining({ p_guest_message: "Fuite précisée", p_location: "Piscine", p_route_id: null }));
    await applyServiceRequestCommandClient({ hotelId, requestId, command: "assign", routeId: requestId });
    expect(rpc).toHaveBeenLastCalledWith("apply_hotel_service_request_command", expect.objectContaining({ p_route_id: requestId, p_guest_message: null }));
  });
  it.each([[saveServiceRouteClient, "client"], [saveServiceRouteBackoffice, "backoffice"]] as const)("saves/deactivates routes in fixed scope (%s, %s)", async (action, scope) => {
    await action({ hotelId, routeId: requestId, category: "technical", label: "Maintenance", phoneE164: "+33612345678", isActive: false });
    expect(authorize).toHaveBeenCalledWith(hotelId, scope);
    expect(rpc).toHaveBeenCalledWith("save_hotel_service_route", expect.objectContaining({ p_route_id: requestId, p_is_active: false, p_hotel_id: hotelId }));
  });
  it("does not disclose DB errors containing personal data", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "private +33612345678 guest text" } });
    const result = await createServiceRequestClient(input);
    expect(result).toEqual({ ok: false, error: "Impossible de créer la demande." });
  });
  it("surfaces rejected transitions as unsuccessful actions", async () => {
    rpc.mockResolvedValue({ error: { code: "22023" } });
    expect((await applyServiceRequestCommandClient({ hotelId, requestId, command: "resolve" })).ok).toBe(false);
  });
});
