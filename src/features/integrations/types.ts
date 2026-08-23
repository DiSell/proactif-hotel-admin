/**
 * Common ground between the two integration capabilities (availability,
 * reservations). Does NOT replace src/features/availability/types.ts —
 * AvailabilityProvider stays defined there, unchanged, as the Phase A
 * contract. This file adds what Phase B introduces: capabilities and the
 * reservation-side provider contracts.
 *
 * Deliberately four independent interfaces, not one monolithic
 * ReservationProvider — a provider that can read a reservation is not
 * necessarily allowed to create, modify, or cancel one, and the type system
 * should make that representable rather than forcing every adapter to stub
 * three methods it can't (or isn't authorized to) implement. What an
 * adapter implements TECHNICALLY authorizes nothing by itself either way:
 * only the capabilities enabled in hotel_integrations.capabilities (Phase B
 * migration) authorize a real call — the orchestrator (Phase C) must check
 * the capability before every call, independently of the other three.
 */

import type {
  CancelReservationRequest,
  CancelReservationResult,
  CreateReservationRequest,
  CreateReservationResult,
  GetReservationRequest,
  ModifyReservationRequest,
  ModifyReservationResult,
  ReservationSnapshot,
} from "../reservations/types";
import type { AvailabilityProvider } from "../availability/types";
import type { ProviderRegistry } from "./registry";

export type IntegrationCapability =
  | "availability"
  | "rates"
  | "booking_url"
  | "reservation_read"
  | "reservation_create"
  | "reservation_modify"
  | "reservation_cancel";

export interface ReservationReadProvider {
  integrationId: string;
  provider: string;
  getReservation(request: GetReservationRequest): Promise<ReservationSnapshot>;
}

export interface ReservationCreateProvider {
  integrationId: string;
  provider: string;
  createReservation(request: CreateReservationRequest): Promise<CreateReservationResult>;
}

export interface ReservationModifyProvider {
  integrationId: string;
  provider: string;
  modifyReservation(request: ModifyReservationRequest): Promise<ModifyReservationResult>;
}

export interface ReservationCancelProvider {
  integrationId: string;
  provider: string;
  cancelReservation(request: CancelReservationRequest): Promise<CancelReservationResult>;
}

/**
 * Registry contracts — one per capability, all built on the same generic
 * ProviderRegistry<TAdapter> (see registry.ts). A resolver must check BOTH
 * that a capability is enabled in hotel_integrations.capabilities (the DB
 * side) AND that the registry actually has an adapter registered for that
 * integration's provider key (the code side) — neither one alone is ever
 * enough. See DatabaseAvailabilityProviderResolver/pickAvailabilityProvider
 * (src/features/availability/resolver.ts) for the only capability where
 * this is actually wired up in Phase B.
 *
 * The four reservation_* registries below exist so Phase C's orchestrator
 * can reuse the exact same discipline without having to invent it — no
 * reservation orchestrator is implemented in Phase B, only the contract
 * shape.
 */
type AdapterFactory<TAdapter> = (integration: { integrationId: string; provider: string }) => TAdapter;

export type AvailabilityAdapterFactory = AdapterFactory<AvailabilityProvider>;
export type AvailabilityAdapterRegistry = ProviderRegistry<AvailabilityAdapterFactory>;

export type ReservationReadAdapterFactory = AdapterFactory<ReservationReadProvider>;
export type ReservationReadAdapterRegistry = ProviderRegistry<ReservationReadAdapterFactory>;

export type ReservationCreateAdapterFactory = AdapterFactory<ReservationCreateProvider>;
export type ReservationCreateAdapterRegistry = ProviderRegistry<ReservationCreateAdapterFactory>;

export type ReservationModifyAdapterFactory = AdapterFactory<ReservationModifyProvider>;
export type ReservationModifyAdapterRegistry = ProviderRegistry<ReservationModifyAdapterFactory>;

export type ReservationCancelAdapterFactory = AdapterFactory<ReservationCancelProvider>;
export type ReservationCancelAdapterRegistry = ProviderRegistry<ReservationCancelAdapterFactory>;
