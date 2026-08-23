/**
 * Phase B contract for reservation operations. Types only — no adapter, no
 * real write, no confirmation UI (all Phase C). See the plan for the full
 * phase breakdown and the rationale behind every rule documented below.
 */

import type { Money } from "../availability/types";

export interface ReservationGuest {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
}

export interface ReservationStay {
  checkIn: string;
  checkOut: string;
  adults: number;
  childrenCount: number;
  childrenAges: number[] | null;
  rooms: number;
}

/**
 * Independent of the provider — never a raw provider status string. A
 * timeout after a create POST is UNKNOWN, never FAILED: the provider may
 * have created the reservation despite a lost response. FAILED means an
 * EXPLICIT, valid confirmation that creation did NOT happen. UNKNOWN covers
 * everything else (timeout, network error, ambiguous response) — same
 * discipline as AvailabilityStatus in Phase A. Reconciling an UNKNOWN
 * (re-reading via getReservation before telling the visitor anything) is a
 * Phase C concern; Phase B only guarantees the contract makes it possible.
 */
export type ReservationStatus = "PENDING" | "CONFIRMED" | "CANCELLED" | "FAILED" | "UNKNOWN";

/**
 * Server-resolved, tenant-safe snapshot of ONE specific offer (see
 * supabase/migrations/0005_integrations_reservations.sql — booking_quotes).
 * `quoteRef` (CreateReservationRequest.quoteRef / ReservationQuoteSummary.quoteRef)
 * is the opaque reference the browser is ever allowed to hold — a
 * booking_quotes.id, non-guessable, carrying no meaning of its own. The
 * server resolves every transactional fact below from the referenced row;
 * none of these fields are ever trusted if a caller also supplies them
 * directly alongside a quoteRef.
 */
export interface ReservationQuoteSummary {
  quoteRef: string;
  hotelId: string;
  integrationId: string;
  accommodationTypeId: string;
  externalAccommodationId: string;
  stay: ReservationStay;
  /** Null when the provider didn't price this offer — same rule as AvailabilityItem.totalPrice (Phase A). */
  totalPrice: Money | null;
  /** Null when the provider never signaled an expiry. A quote past expiresAt (or one whose provider offer no longer matches) must be re-resolved into a NEW quoteRef, never silently reused — see OFFER_EXPIRED/PRICE_CHANGED/NO_LONGER_AVAILABLE below. */
  expiresAt: string | null;
}

export interface CreateReservationRequest {
  hotelId: string;
  /**
   * Opaque server-side reference to a previously resolved ReservationQuoteSummary
   * (booking_quotes row) — never a bare accommodation name, and never a raw
   * provider offer id handed straight to the client. integrationId,
   * accommodationTypeId, externalAccommodationId, the provider offer/rate,
   * stay (dates/occupancy) and price/currency are ALL resolved server-side
   * from this reference — a caller can never override any of them by
   * supplying its own value alongside quoteRef; there is deliberately no
   * field on this type that could do so.
   */
  quoteRef: string;
  guest: ReservationGuest;
  specialRequests: string | null;
  /** Never optional — generated once, at the moment of explicit visitor confirmation, never regenerated on a retry of the same intent. */
  idempotencyKey: string;
}

export interface CreateReservationResult {
  status: ReservationStatus;
  /** Null until something is confirmed created (see ReservationStatus — stays null while status is UNKNOWN). */
  externalReservationId: string | null;
  confirmationNumber: string | null;
  providerStatus: string | null;
  totalPrice: Money | null;
  createdAt: string;
}

export interface GetReservationRequest {
  hotelId: string;
  integrationId: string;
  externalReservationId: string;
}

export interface ReservationSnapshot {
  status: ReservationStatus;
  externalReservationId: string;
  confirmationNumber: string | null;
  providerStatus: string | null;
  stay: ReservationStay;
  guest: ReservationGuest;
  totalPrice: Money | null;
}

/**
 * Deliberately NOT a general-purpose PATCH: only guest contact info and
 * specialRequests are modifiable as plain fields, because they carry no
 * transactional/pricing consequence. Dates, accommodation, rate, price and
 * occupancy are NEVER accepted as raw client-supplied values here — there
 * is no `stay` field on this type on purpose. A modification that changes
 * any of those requires `newQuoteRef`: a fresh ReservationQuoteSummary
 * resolved server-side for the new terms (same guarantees as
 * CreateReservationRequest.quoteRef), never trusted from the browser
 * directly. No workflow resolves newQuoteRef in Phase B — Phase C wires it
 * — but the contract never lets a browser-supplied date/price masquerade as
 * a fact either way.
 */
export interface ModifyReservationRequest {
  hotelId: string;
  integrationId: string;
  externalReservationId: string;
  guest: Partial<ReservationGuest>;
  specialRequests: string | null;
  /** Required whenever the modification changes dates, accommodation, rate, price or occupancy. Omitted for a guest/specialRequests-only change. */
  newQuoteRef?: string;
  /** Same rule as CreateReservationRequest — a replayed modify must never duplicate its effect. */
  idempotencyKey: string;
}

export interface ModifyReservationResult {
  status: ReservationStatus;
  externalReservationId: string;
  confirmationNumber: string | null;
  providerStatus: string | null;
  totalPrice: Money | null;
  updatedAt: string;
}

export interface CancelReservationRequest {
  hotelId: string;
  integrationId: string;
  externalReservationId: string;
  reason: string | null;
  /** Same rule as CreateReservationRequest — a replayed cancel must never duplicate its effect. */
  idempotencyKey: string;
}

export interface CancelReservationResult {
  status: ReservationStatus;
  externalReservationId: string;
  cancelledAt: string | null;
}

/**
 * OFFER_EXPIRED / PRICE_CHANGED / NO_LONGER_AVAILABLE all mean the same
 * thing at the confirmation layer: the quoteRef the visitor confirmed no
 * longer represents a valid offer. None of the three is recoverable by
 * retrying createReservation with the same quoteRef — the required
 * response is always: invalidate that confirmation -> re-run
 * checkAvailability -> present the new terms -> obtain a NEW explicit
 * confirmation bound to a NEW quoteRef (see ReservationQuoteSummary). Not
 * wired in Phase B (no confirmation workflow exists yet) — this is the
 * contract those three codes exist to make representable.
 */
export type ReservationErrorCode =
  | "RESERVATION_NOT_FOUND"
  | "OFFER_EXPIRED"
  | "NO_LONGER_AVAILABLE"
  | "PRICE_CHANGED"
  | "INVALID_GUEST_DATA"
  | "AUTH_ERROR"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "INVALID_RESPONSE"
  | "IDEMPOTENCY_CONFLICT"
  | "CONFIRMATION_REQUIRED";

export interface ReservationError {
  code: ReservationErrorCode;
  message: string;

  hotelId: string;
  integrationId?: string;
  provider?: string;

  retryable: boolean;
  retryAfterSeconds?: number;

  /** Server-log-only cause. Must never be exposed directly to the visitor — same rule as IntegrationError (Phase A). */
  cause?: unknown;
}
