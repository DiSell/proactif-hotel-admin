import { beforeEach, describe, expect, it, vi } from "vitest";
const { authorize } = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireHotelAccess: authorize }));
import { getServiceRequest, listServiceRequests, listServiceRequestEvents, listServiceRoutes } from "./queries";

const hotelId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const builder = {
  select: vi.fn(), eq: vi.fn(), order: vi.fn(),
  maybeSingle: vi.fn(), returns: vi.fn(),
};
const from = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  from.mockReturnValue(builder);
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.maybeSingle.mockResolvedValue({ data: null, error: null });
  builder.returns.mockResolvedValue({ data: [], error: null });
  authorize.mockResolvedValue({ supabase: { from } });
});
describe("authorized service request reads", () => {
  it("scopes a request by both hotel and request id, returning null for inaccessible ids", async () => {
    expect(await getServiceRequest(hotelId, requestId, "client")).toBeNull();
    expect(authorize).toHaveBeenCalledWith(hotelId, "client");
    expect(builder.eq.mock.calls).toEqual([["hotel_id", hotelId], ["id", requestId]]);
  });
  it("rejects an unauthorized hotel before any query", async () => {
    authorize.mockRejectedValue(new Error("forbidden"));
    await expect(getServiceRequest(hotelId, requestId, "client")).rejects.toThrow("forbidden");
    expect(from).not.toHaveBeenCalled();
  });
  it.each([
    ["requests", () => listServiceRequests(hotelId, "client"), "hotel_service_requests"],
    ["routes", () => listServiceRoutes(hotelId, "backoffice"), "hotel_service_routes"],
    ["events", () => listServiceRequestEvents(hotelId, requestId, "client"), "hotel_service_request_events"],
  ] as const)("scopes %s reads and uses explicit columns", async (_name, call, table) => {
    expect(await call()).toEqual([]);
    expect(from).toHaveBeenCalledWith(table);
    expect(builder.eq).toHaveBeenCalledWith("hotel_id", hotelId);
    expect(builder.select).not.toHaveBeenCalledWith("*");
    if (table === "hotel_service_request_events") expect(builder.eq).toHaveBeenCalledWith("service_request_id", requestId);
  });
  it("rejects malformed identifiers before authentication/query", async () => {
    await expect(getServiceRequest("bad", requestId, "client")).rejects.toThrow();
    expect(authorize).not.toHaveBeenCalled();
  });
  it("does not disclose database error details", async () => {
    builder.maybeSingle.mockResolvedValue({ data: null, error: { message: "private" } });
    await expect(getServiceRequest(hotelId, requestId, "client")).rejects.toThrow("Impossible de charger la demande.");
  });
});
