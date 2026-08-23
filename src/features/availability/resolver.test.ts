import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pickAvailabilityProvider } from "./resolver";
import { MapProviderRegistry } from "../integrations/registry";
import type { AvailabilityAdapterFactory, AvailabilityAdapterRegistry } from "../integrations/types";
import type { AvailabilityProvider } from "./types";

function fakeAdapter(): AvailabilityAdapterFactory {
  return ({ integrationId, provider }) => {
    const p: AvailabilityProvider = {
      integrationId,
      provider,
      requiredFields: ["checkIn", "checkOut"],
      checkAvailability: async () => {
        throw new Error("not implemented in this test");
      },
    };
    return p;
  };
}

function registryOf(adapters: Record<string, AvailabilityAdapterFactory>): AvailabilityAdapterRegistry {
  return new MapProviderRegistry(adapters);
}

describe("pickAvailabilityProvider", () => {
  it("returns no_integration when there are no routes at all", () => {
    const result = pickAvailabilityProvider([], registryOf({}));
    expect(result).toEqual({ provider: null, reason: "no_integration" });
  });

  it("returns capability_not_supported when a route exists but the integration lacks the availability capability", () => {
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "int-1", provider: "mews", status: "active", capabilities: ["reservation_read"] } }],
      registryOf({ mews: fakeAdapter() })
    );
    expect(result).toEqual({ provider: null, reason: "capability_not_supported" });
  });

  it("returns capability_not_supported when the integration has the capability but isn't active", () => {
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "int-1", provider: "mews", status: "configured", capabilities: ["availability"] } }],
      registryOf({ mews: fakeAdapter() })
    );
    expect(result).toEqual({ provider: null, reason: "capability_not_supported" });
  });

  it("returns capability_not_supported when active+capable but no adapter is registered for that provider (Phase B default — no real adapter shipped)", () => {
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "int-1", provider: "mews", status: "active", capabilities: ["availability"] } }],
      registryOf({})
    );
    expect(result).toEqual({ provider: null, reason: "capability_not_supported" });
  });

  it("[unknown provider] refuses cleanly when the DB provider key isn't in the registry at all, even with other providers registered", () => {
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "int-1", provider: "totally-unknown-provider", status: "active", capabilities: ["availability"] } }],
      registryOf({ mews: fakeAdapter(), amenitiz: fakeAdapter() })
    );
    expect(result).toEqual({ provider: null, reason: "capability_not_supported" });
  });

  it("[capability DB=true, adapter incapable/missing] capability enabled in DB is not enough on its own", () => {
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "int-1", provider: "mews", status: "active", capabilities: ["availability"] } }],
      registryOf({}) // no adapter registered at all for "mews"
    );
    expect(result.provider).toBeNull();
  });

  it("[adapter capable, capability DB=false] a registered adapter is not enough on its own", () => {
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "int-1", provider: "mews", status: "active", capabilities: [] } }],
      registryOf({ mews: fakeAdapter() })
    );
    expect(result.provider).toBeNull();
  });

  it("resolves the active, capable integration when an adapter is registered for it", () => {
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "int-1", provider: "mews", status: "active", capabilities: ["availability"] } }],
      registryOf({ mews: fakeAdapter() })
    );
    expect(result.provider).not.toBeNull();
    expect(result.provider?.integrationId).toBe("int-1");
    expect(result.provider?.provider).toBe("mews");
  });

  it("respects priority order — picks priority 1 over priority 2 when both qualify", () => {
    const result = pickAvailabilityProvider(
      [
        { priority: 2, integration: { id: "int-low-priority", provider: "amenitiz", status: "active", capabilities: ["availability"] } },
        { priority: 1, integration: { id: "int-high-priority", provider: "mews", status: "active", capabilities: ["availability"] } },
      ],
      registryOf({ mews: fakeAdapter(), amenitiz: fakeAdapter() })
    );
    expect(result.provider?.integrationId).toBe("int-high-priority");
  });

  it("respects priority order even when rows arrive out of order from the query", () => {
    const result = pickAvailabilityProvider(
      [
        { priority: 3, integration: { id: "int-c", provider: "c", status: "active", capabilities: ["availability"] } },
        { priority: 1, integration: { id: "int-a", provider: "a", status: "active", capabilities: ["availability"] } },
        { priority: 2, integration: { id: "int-b", provider: "b", status: "active", capabilities: ["availability"] } },
      ],
      registryOf({ a: fakeAdapter(), b: fakeAdapter(), c: fakeAdapter() })
    );
    expect(result.provider?.integrationId).toBe("int-a");
  });

  it("falls through to the next-priority route when the higher-priority one doesn't qualify", () => {
    const result = pickAvailabilityProvider(
      [
        { priority: 1, integration: { id: "int-disconnected", provider: "mews", status: "disconnected", capabilities: ["availability"] } },
        { priority: 2, integration: { id: "int-active", provider: "amenitiz", status: "active", capabilities: ["availability"] } },
      ],
      registryOf({ mews: fakeAdapter(), amenitiz: fakeAdapter() })
    );
    expect(result.provider?.integrationId).toBe("int-active");
  });

  it("handles a null embedded integration (orphaned route) without throwing", () => {
    const result = pickAvailabilityProvider([{ priority: 1, integration: null }], registryOf({}));
    expect(result).toEqual({ provider: null, reason: "capability_not_supported" });
  });

  it("never leaks a provider from a different hotel — scoping is entirely the caller's query, this function only ever sees rows already filtered by hotel_id", () => {
    // pickAvailabilityProvider has no hotelId parameter at all: it can only
    // ever act on the rows it's handed. Tenant isolation is therefore fully
    // owned by the .eq("hotel_id", hotelId) call in resolve() below, which
    // the source-guard test in this file verifies is actually present.
    const result = pickAvailabilityProvider(
      [{ priority: 1, integration: { id: "other-hotel-int", provider: "mews", status: "active", capabilities: ["availability"] } }],
      registryOf({ mews: fakeAdapter() })
    );
    expect(result.provider?.integrationId).toBe("other-hotel-int");
  });
});

/**
 * DatabaseAvailabilityProviderResolver.resolve() itself is Supabase-touching
 * and can't be unit-tested directly (same constraint as other
 * Supabase-touching code in this repo — see actions.test.ts) — checked at
 * the source level instead. The actual selection logic it delegates to
 * (pickAvailabilityProvider, above) IS fully unit-tested.
 */
describe("DatabaseAvailabilityProviderResolver — source guards", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "resolver.ts"), "utf8");
  const fn = source.slice(source.indexOf("class DatabaseAvailabilityProviderResolver"));

  it("scopes the query to the requested hotel_id — never a cross-hotel read", () => {
    expect(fn).toMatch(/\.eq\("hotel_id", hotelId\)/);
  });

  it("filters to the availability capability specifically", () => {
    expect(fn).toMatch(/\.eq\("capability", "availability"\)/);
  });

  it("orders by priority ascending — lower priority number wins", () => {
    expect(fn).toMatch(/\.order\("priority", \{ ascending: true \}\)/);
  });

  it("delegates the actual decision to the pure, unit-tested function rather than deciding inline", () => {
    expect(fn).toMatch(/pickAvailabilityProvider\(/);
  });

  it("depends on the ProviderRegistry contract, not a raw object literal — defaults to an empty MapProviderRegistry, never a hardcoded adapter", () => {
    expect(source).toMatch(/registry: AvailabilityAdapterRegistry = new MapProviderRegistry\(\)/);
  });
});
