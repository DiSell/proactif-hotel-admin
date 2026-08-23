import type { createClient } from "@/lib/supabase/server";
import { MapProviderRegistry } from "../integrations/registry";
import type { AvailabilityAdapterRegistry } from "../integrations/types";
import type { AvailabilityProviderResolver, ProviderResolution } from "./types";

/**
 * The only AvailabilityProviderResolver implementation in this codebase
 * (Phase A) — no hotel has a real PMS/booking-engine/channel-manager
 * integration configured anywhere in this repo. Always resolves to "no
 * provider", honestly, never a simulated success.
 *
 * Consumers (checkAvailability.ts, answer.ts) depend on the
 * AvailabilityProviderResolver INTERFACE, never on this concrete class —
 * Phase B's DatabaseAvailabilityProviderResolver (backed by a future
 * hotel_integrations table, capability routing, and a provider registry)
 * will implement the same interface, and no caller will need to change
 * when that lands.
 */
export class NoopAvailabilityProviderResolver implements AvailabilityProviderResolver {
  async resolve(): Promise<ProviderResolution> {
    return { provider: null, reason: "no_integration" };
  }
}

interface IntegrationRow {
  id: string;
  provider: string;
  status: string;
  capabilities: string[];
}

interface CapabilityRouteRow {
  priority: number;
  integration: IntegrationRow | IntegrationRow[] | null;
}

function normalizeIntegration(integration: IntegrationRow | IntegrationRow[] | null): IntegrationRow | null {
  // Supabase's embedded-resource typing allows an array even for a to-one FK join — this repo's schema guarantees at most one row via the (id, hotel_id) unique index, so only the first entry is ever meaningful.
  if (Array.isArray(integration)) return integration[0] ?? null;
  return integration;
}

/**
 * Pure decision logic, deliberately separated from the Supabase fetch below
 * so it's testable without a database — same split as checkAvailability.ts
 * (computeMissingFields/buildRequest) and answer.ts's pure helpers.
 *
 * `registry` is empty by default: Phase B ships no real adapter
 * implementation (see plan). A route can point at an active, capable
 * integration and this still returns "capability_not_supported" if the
 * registry has no adapter for that provider string — capability DB=true
 * AND a registered adapter are BOTH required, neither alone is ever enough.
 * An unregistered/unknown provider key is refused the exact same way as a
 * missing capability — never a simulated success just because a database
 * row exists. Phase C is expected to pass a populated registry.
 */
export function pickAvailabilityProvider(routes: CapabilityRouteRow[], registry: AvailabilityAdapterRegistry): ProviderResolution {
  if (routes.length === 0) return { provider: null, reason: "no_integration" };

  const sorted = [...routes].sort((a, b) => a.priority - b.priority);

  for (const route of sorted) {
    const integration = normalizeIntegration(route.integration);
    if (!integration) continue;
    if (integration.status !== "active") continue;
    if (!integration.capabilities.includes("availability")) continue;

    const factory = registry.resolve(integration.provider);
    if (!factory) continue;

    return { provider: factory({ integrationId: integration.id, provider: integration.provider }) };
  }

  return { provider: null, reason: "capability_not_supported" };
}

/**
 * Phase B implementation of AvailabilityProviderResolver — reads
 * hotel_integration_capability_routes + hotel_integrations (Phase B
 * migration, not yet applied — see supabase/migrations). Same interface as
 * NoopAvailabilityProviderResolver, so answer.ts's only required change,
 * when this is wired in (Phase C), is which resolver it constructs.
 *
 * `registry` defaults to an empty MapProviderRegistry — see
 * pickAvailabilityProvider. No caller in this repo constructs this class
 * yet (see plan §16 — answer.ts keeps using NoopAvailabilityProviderResolver
 * until Phase C), and no caller registers any adapter in it either.
 */
export class DatabaseAvailabilityProviderResolver implements AvailabilityProviderResolver {
  constructor(
    private readonly supabase: Awaited<ReturnType<typeof createClient>>,
    private readonly registry: AvailabilityAdapterRegistry = new MapProviderRegistry()
  ) {}

  async resolve(hotelId: string): Promise<ProviderResolution> {
    const { data, error } = await this.supabase
      .from("hotel_integration_capability_routes")
      .select("priority, integration:hotel_integrations(id, provider, status, capabilities)")
      .eq("hotel_id", hotelId)
      .eq("capability", "availability")
      .order("priority", { ascending: true });

    if (error || !data) return { provider: null, reason: "no_integration" };

    return pickAvailabilityProvider(data as unknown as CapabilityRouteRow[], this.registry);
  }
}
