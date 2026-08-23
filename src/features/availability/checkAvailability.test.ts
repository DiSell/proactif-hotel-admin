import { describe, expect, it, vi } from "vitest";
import { checkAvailability } from "./checkAvailability";
import type { AvailabilityProvider, AvailabilityProviderResolver, AvailabilityRequest, AvailabilityResult, ProviderResolution, RequiredField, StayRequestState } from "./types";

function state(overrides: Partial<StayRequestState> = {}): StayRequestState {
  return { checkIn: "2026-09-12", checkOut: "2026-09-15", adults: 2, childrenCount: 0, childrenAges: [], rooms: 1, ...overrides };
}

class FakeResolver implements AvailabilityProviderResolver {
  constructor(private resolution: ProviderResolution) {}
  async resolve(): Promise<ProviderResolution> {
    return this.resolution;
  }
}

function fakeProvider(requiredFields: RequiredField[], impl: (request: AvailabilityRequest) => Promise<AvailabilityResult>): AvailabilityProvider {
  return { integrationId: "test-integration", provider: "test-provider", requiredFields, checkAvailability: impl };
}

function okResult(overrides: Partial<AvailabilityResult> = {}): AvailabilityResult {
  return { integrationId: "test-integration", provider: "test-provider", checkedAt: new Date().toISOString(), availabilityStatus: "UNKNOWN", items: [], ...overrides };
}

describe("checkAvailability — no_provider", () => {
  it("is determined even when the stay state is still incomplete — no network call attempted", async () => {
    const checkFn = vi.fn();
    const resolver = new FakeResolver({ provider: null, reason: "no_integration" });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state({ checkIn: null, checkOut: null, adults: null }), resolver });
    expect(result).toEqual({ kind: "no_provider" });
    expect(checkFn).not.toHaveBeenCalled();
  });
});

describe("checkAvailability — missing_input", () => {
  it("requires checkIn/checkOut structurally, regardless of provider.requiredFields", async () => {
    const checkFn = vi.fn();
    const provider = fakeProvider([], checkFn);
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state({ checkIn: null }), resolver });
    expect(result).toEqual({ kind: "missing_input", missingFields: ["checkIn"] });
    expect(checkFn).not.toHaveBeenCalled();
  });

  it("a provider that does NOT list childrenAges as required never demands it, even with children present and ages unknown", async () => {
    const checkFn = vi.fn().mockResolvedValue(okResult());
    const provider = fakeProvider(["adults"], checkFn); // no "childrenAges" here
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state({ childrenCount: 2, childrenAges: null }), resolver });
    expect(result.kind).toBe("checked");
    expect(checkFn).toHaveBeenCalledOnce();
  });

  it("a provider that DOES list childrenAges as required blocks the call when ages are incomplete", async () => {
    const checkFn = vi.fn();
    const provider = fakeProvider(["childrenAges"], checkFn);
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state({ childrenCount: 2, childrenAges: [8] }), resolver });
    expect(result).toEqual({ kind: "missing_input", missingFields: ["childrenAges"] });
    expect(checkFn).not.toHaveBeenCalled();
  });

  it("childrenCount = 0 never triggers a childrenAges requirement, even if the provider lists it", async () => {
    const checkFn = vi.fn().mockResolvedValue(okResult());
    const provider = fakeProvider(["childrenAges"], checkFn);
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state({ childrenCount: 0, childrenAges: [] }), resolver });
    expect(result.kind).toBe("checked");
  });
});

describe("checkAvailability — provider errors never become a fabricated status", () => {
  it("a thrown error resolves to unknown, never UNAVAILABLE", async () => {
    const provider = fakeProvider([], async () => {
      throw new Error("network exploded");
    });
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state(), resolver });
    expect(result.kind).toBe("unknown");
  });

  it("AUTH_ERROR resolves to unknown without retrying", async () => {
    const checkFn = vi.fn().mockResolvedValue(
      okResult({ error: { code: "AUTH_ERROR", message: "bad credentials", hotelId: "hotel-1", retryable: false } })
    );
    const provider = fakeProvider([], checkFn);
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state(), resolver });
    expect(result.kind).toBe("unknown");
    expect(checkFn).toHaveBeenCalledOnce();
  });

  it("TIMEOUT retries a bounded number of times then resolves to unknown", async () => {
    const checkFn = vi.fn().mockResolvedValue(
      okResult({ error: { code: "TIMEOUT", message: "timed out", hotelId: "hotel-1", retryable: true } })
    );
    const provider = fakeProvider([], checkFn);
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state(), resolver });
    expect(result.kind).toBe("unknown");
    expect(checkFn.mock.calls.length).toBeGreaterThan(1);
    expect(checkFn.mock.calls.length).toBeLessThan(10); // bounded, not infinite
  });

  it("an empty items list with an undocumented/UNKNOWN semantic is passed through as-is — never reinterpreted as UNAVAILABLE", async () => {
    const provider = fakeProvider([], async () => okResult({ availabilityStatus: "UNKNOWN", items: [] }));
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state(), resolver });
    expect(result.kind).toBe("checked");
    if (result.kind === "checked") {
      expect(result.result.items).toEqual([]);
      expect(result.result.availabilityStatus).toBe("UNKNOWN");
    }
  });
});

describe("checkAvailability — heterogeneous items preserved without collapsing", () => {
  it("A=AVAILABLE, B=UNAVAILABLE, C=UNKNOWN in the same response are returned exactly as given", async () => {
    const heterogeneousResult = okResult({
      items: [
        { externalAccommodationId: "A", availabilityStatus: "AVAILABLE" },
        { externalAccommodationId: "B", availabilityStatus: "UNAVAILABLE" },
        { externalAccommodationId: "C", availabilityStatus: "UNKNOWN" },
      ],
    });
    const provider = fakeProvider([], async () => heterogeneousResult);
    const resolver = new FakeResolver({ provider });
    const result = await checkAvailability({ hotelId: "hotel-1", state: state(), resolver });
    expect(result.kind).toBe("checked");
    if (result.kind === "checked") {
      expect(result.result.items.map((i) => i.availabilityStatus)).toEqual(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]);
    }
  });
});
