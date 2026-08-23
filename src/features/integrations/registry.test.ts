import { describe, expect, it } from "vitest";
import { MapProviderRegistry } from "./registry";

describe("MapProviderRegistry", () => {
  it("resolves a registered provider key to its adapter", () => {
    const adapter = { name: "mews-adapter" };
    const registry = new MapProviderRegistry({ mews: adapter });
    expect(registry.resolve("mews")).toBe(adapter);
  });

  it("returns undefined for an unknown provider key — never fabricates a fallback adapter", () => {
    const registry = new MapProviderRegistry({ mews: { name: "mews-adapter" } });
    expect(registry.resolve("unknown-provider")).toBeUndefined();
  });

  it("defaults to an empty registry — resolves nothing when constructed with no adapters (Phase B state)", () => {
    const registry = new MapProviderRegistry();
    expect(registry.resolve("mews")).toBeUndefined();
  });

  it("keeps distinct provider keys independent", () => {
    const mews = { name: "mews-adapter" };
    const amenitiz = { name: "amenitiz-adapter" };
    const registry = new MapProviderRegistry({ mews, amenitiz });
    expect(registry.resolve("mews")).toBe(mews);
    expect(registry.resolve("amenitiz")).toBe(amenitiz);
  });
});
