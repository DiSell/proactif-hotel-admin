/**
 * Phase A contract for real-time availability checking. Nothing in this
 * repo implements a real provider yet (see resolver.ts) — these types exist
 * so the runtime orchestration (checkAvailability.ts, answer.ts) can be
 * built and fully tested now, without being rewritten when a Phase B
 * (hotel_integrations, provider registry) and Phase C (first real adapter)
 * land later. See the plan for the full phase breakdown.
 */

export type AvailabilityStatus = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";

export interface Money {
  /** Decimal value serialized as a string to avoid floating-point rounding errors. Example: "349.90" */
  amount: string;
  /** ISO 4217 code. Example: "EUR" */
  currency: string;
}

export interface StayRequestState {
  checkIn: string | null;
  checkOut: string | null;
  adults: number | null;
  childrenCount: number | null;
  childrenAges: number[] | null;
  rooms: number | null;
}

export interface AvailabilityRequest {
  hotelId: string;
  checkIn: string;
  checkOut: string;

  /**
   * Occupancy fields stay nullable in the normalized contract — it's the
   * required fields declared by the adapter that determine whether the
   * call can actually be made (see AvailabilityProvider.requiredFields).
   */
  adults: number | null;
  childrenCount: number | null;
  childrenAges: number[] | null;
  rooms: number | null;

  /** Internal business candidates. An absent list means the request doesn't restrict the call to specific accommodation types. */
  accommodationTypeIds?: string[];

  locale?: string;
}

export interface AvailabilityItem {
  externalAccommodationId: string;
  availabilityStatus: AvailabilityStatus;

  remainingUnits?: number | null;

  /** The two prices are independent: a provider may supply one, both, or neither. */
  totalPrice?: Money | null;
  nightlyPrice?: Money | null;

  bookingUrl?: string | null;
  providerMetadata?: Record<string, unknown>;

  /** Opaque offer/rate id, provider-specific — present only if the provider emits one. Reused as-is in CreateReservationRequest.offerId (Phase B, src/features/reservations/types.ts). Never a fixed validity duration across providers: a provider signals an expired offer via OFFER_EXPIRED at createReservation time. */
  offerId?: string | null;
}

export interface AvailabilityResult {
  integrationId: string;
  provider: string;
  checkedAt: string;

  /**
   * Global status of the request only in the narrow sense the type allows —
   * per-accommodation items (below) are the real, authoritative granularity
   * and must never be collapsed into this single field for guidance or
   * filtering purposes. See AvailabilityCheckState below.
   */
  availabilityStatus: AvailabilityStatus;

  items: AvailabilityItem[];

  /** Present when the status is UNKNOWN as a result of a known error. */
  error?: IntegrationError;
}

export type IntegrationErrorCode =
  | "NO_PROVIDER"
  | "CAPABILITY_NOT_SUPPORTED"
  | "MISSING_MAPPING"
  | "MISSING_REQUIRED_INPUT"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE";

export interface IntegrationError {
  code: IntegrationErrorCode;
  message: string;

  hotelId: string;
  integrationId?: string;
  provider?: string;

  retryable: boolean;

  /** Delay recommended by the provider, notably after an HTTP 429. */
  retryAfterSeconds?: number;

  /** Fields needed before the API can be called. Used mainly with MISSING_REQUIRED_INPUT. */
  missingFields?: RequiredField[];

  /** Server-log-only cause. Must never be exposed directly to the visitor. */
  cause?: unknown;
}

export type RequiredField = "checkIn" | "checkOut" | "adults" | "childrenCount" | "childrenAges" | "rooms";

export interface AvailabilityProvider {
  integrationId: string;
  provider: string;
  requiredFields: RequiredField[];
  checkAvailability(request: AvailabilityRequest): Promise<AvailabilityResult>;
}

/**
 * Result of resolving a provider for a hotel — never a bare nullable
 * provider: it also carries WHY none was found, so guidance/logging never
 * has to guess.
 */
export type ProviderResolution = { provider: AvailabilityProvider } | { provider: null; reason: "no_integration" | "capability_not_supported" };

/** Consumers depend on this interface, never on a concrete resolver — see resolver.ts (NoopAvailabilityProviderResolver is the only Phase A implementation). */
export interface AvailabilityProviderResolver {
  resolve(hotelId: string): Promise<ProviderResolution>;
}

/**
 * Runtime state for THIS turn — never a fixed string. Driven by what
 * actually happened (no provider / missing input / checked result / failed)
 * rather than a hardcoded assumption about the product's current state.
 *
 * "checked" never carries a single global status: AvailabilityResult holds
 * one item per accommodation (A can be AVAILABLE while B is UNAVAILABLE and
 * C is UNKNOWN, in the same response). Per-accommodationTypeId granularity
 * is preserved all the way to guidance (prompt.ts) and to
 * applyAvailabilityToCandidates — an UNKNOWN on one accommodation never
 * invalidates a confirmed AVAILABLE on another, and vice versa.
 */
export type AvailabilityCheckState =
  | { kind: "not_requested" }
  | { kind: "missing_input"; missingFields: RequiredField[] }
  | { kind: "no_provider" }
  | { kind: "checked"; result: AvailabilityResult }
  | { kind: "unknown"; error: IntegrationError };
