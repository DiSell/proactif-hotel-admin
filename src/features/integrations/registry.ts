/**
 * Generic provider registry contract — maps a DB-configured provider key
 * (hotel_integrations.provider) to the adapter that actually implements it.
 * An unknown provider key resolves to undefined; callers must NEVER
 * synthesize a fallback adapter for a key the registry doesn't recognize —
 * a database row alone must never be enough to authorize a call, only a
 * registered adapter does (see resolve() callers in
 * src/features/availability/resolver.ts).
 */
export interface ProviderRegistry<TAdapter> {
  resolve(provider: string): TAdapter | undefined;
}

/**
 * Default, dependency-free ProviderRegistry backed by a plain map of
 * provider key -> adapter factory. Phase C populates one per capability
 * with real adapters; Phase B registers none anywhere in this codebase — no
 * caller constructs one with actual entries (see
 * DatabaseAvailabilityProviderResolver's empty default).
 */
export class MapProviderRegistry<TAdapter> implements ProviderRegistry<TAdapter> {
  private readonly adapters: ReadonlyMap<string, TAdapter>;

  constructor(adapters: Record<string, TAdapter> = {}) {
    this.adapters = new Map(Object.entries(adapters));
  }

  resolve(provider: string): TAdapter | undefined {
    return this.adapters.get(provider);
  }
}
