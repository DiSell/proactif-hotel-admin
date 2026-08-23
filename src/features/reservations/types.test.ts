import { describe, expect, it } from "vitest";
import type {
  CancelReservationRequest,
  CancelReservationResult,
  CreateReservationRequest,
  CreateReservationResult,
  GetReservationRequest,
  ModifyReservationRequest,
  ModifyReservationResult,
  ReservationError,
  ReservationErrorCode,
  ReservationGuest,
  ReservationQuoteSummary,
  ReservationSnapshot,
  ReservationStatus,
  ReservationStay,
} from "./types";
import type {
  ReservationCancelProvider,
  ReservationCreateProvider,
  ReservationModifyProvider,
  ReservationReadProvider,
} from "../integrations/types";

/**
 * No logic exists yet for these contracts (Phase B — types only, per the
 * plan). These are shape/compilation checks: constructing a valid literal
 * of every exported type, checked by `npm run build`'s TypeScript pass.
 * Runtime assertions are minimal on purpose — the point is that the shapes
 * below compile against the exported types, not that they do anything.
 */
describe("reservation contracts — shape", () => {
  const guest: ReservationGuest = { firstName: "Marie", lastName: "Curie", email: "marie@example.com", phone: null };
  const stay: ReservationStay = { checkIn: "2026-09-01", checkOut: "2026-09-03", adults: 2, childrenCount: 0, childrenAges: null, rooms: 1 };

  it("ReservationStatus covers exactly the five documented values", () => {
    const statuses: ReservationStatus[] = ["PENDING", "CONFIRMED", "CANCELLED", "FAILED", "UNKNOWN"];
    expect(statuses).toHaveLength(5);
  });

  it("ReservationQuoteSummary bundles every transactional fact behind one opaque quoteRef", () => {
    const quote: ReservationQuoteSummary = {
      quoteRef: "00000000-0000-0000-0000-000000000001",
      hotelId: "hotel-1",
      integrationId: "int-1",
      accommodationTypeId: "acc-1",
      externalAccommodationId: "ext-acc-1",
      stay,
      totalPrice: { amount: "349.90", currency: "EUR" },
      expiresAt: "2026-09-01T10:15:00.000Z",
    };
    expect(quote.quoteRef).toBeTruthy();
  });

  it("CreateReservationRequest is based on quoteRef + guest + specialRequests + idempotencyKey — nothing else", () => {
    const request: CreateReservationRequest = {
      hotelId: "hotel-1",
      quoteRef: "00000000-0000-0000-0000-000000000001",
      guest,
      specialRequests: null,
      idempotencyKey: "idem-1",
    };
    expect(Object.keys(request).sort()).toEqual(["guest", "hotelId", "idempotencyKey", "quoteRef", "specialRequests"]);
  });

  it("[BLOQUANT regression guard] CreateReservationRequest cannot carry a separate stay/quotedPrice/accommodationTypeId/offerId alongside quoteRef", () => {
    const withStay: CreateReservationRequest = {
      hotelId: "hotel-1",
      quoteRef: "00000000-0000-0000-0000-000000000001",
      guest,
      specialRequests: null,
      idempotencyKey: "idem-1",
      // @ts-expect-error — stay is not assignable to CreateReservationRequest; only quoteRef carries dates/occupancy now. If this stops erroring, the dangerous old shape crept back in.
      stay,
    };
    const withPrice: CreateReservationRequest = {
      hotelId: "hotel-1",
      quoteRef: "00000000-0000-0000-0000-000000000001",
      guest,
      specialRequests: null,
      idempotencyKey: "idem-1",
      // @ts-expect-error — quotedPrice is not assignable to CreateReservationRequest; price comes only from the resolved quote.
      quotedPrice: { amount: "1.00", currency: "EUR" },
    };
    expect(withStay.quoteRef).toBe(withPrice.quoteRef);
  });

  it("CreateReservationResult keeps externalReservationId nullable (UNKNOWN status has no confirmed id)", () => {
    const result: CreateReservationResult = {
      status: "UNKNOWN",
      externalReservationId: null,
      confirmationNumber: null,
      providerStatus: null,
      totalPrice: null,
      createdAt: "2026-09-01T10:00:00.000Z",
    };
    expect(result.externalReservationId).toBeNull();
  });

  it("GetReservationRequest / ReservationSnapshot compile", () => {
    const request: GetReservationRequest = { hotelId: "hotel-1", integrationId: "int-1", externalReservationId: "ext-1" };
    const snapshot: ReservationSnapshot = {
      status: "CONFIRMED",
      externalReservationId: "ext-1",
      confirmationNumber: "CONF-1",
      providerStatus: "ok",
      stay,
      guest,
      totalPrice: { amount: "349.90", currency: "EUR" },
    };
    expect(request.externalReservationId).toBe(snapshot.externalReservationId);
  });

  it("ModifyReservationRequest has no `stay` field — dates/room/rate changes require newQuoteRef, never raw client values", () => {
    const guestOnly: ModifyReservationRequest = {
      hotelId: "hotel-1",
      integrationId: "int-1",
      externalReservationId: "ext-1",
      guest: { phone: "+33600000000" },
      specialRequests: "Late arrival",
      idempotencyKey: "idem-modify-1",
    };
    const withNewQuote: ModifyReservationRequest = {
      hotelId: "hotel-1",
      integrationId: "int-1",
      externalReservationId: "ext-1",
      guest: {},
      specialRequests: null,
      newQuoteRef: "00000000-0000-0000-0000-000000000002",
      idempotencyKey: "idem-modify-2",
    };
    expect(guestOnly.newQuoteRef).toBeUndefined();
    expect(withNewQuote.newQuoteRef).toBeTruthy();
    expect("stay" in guestOnly).toBe(false);
  });

  it("[BLOQUANT regression guard] ModifyReservationRequest cannot carry a raw stay override", () => {
    const withStay: ModifyReservationRequest = {
      hotelId: "hotel-1",
      integrationId: "int-1",
      externalReservationId: "ext-1",
      guest: {},
      specialRequests: null,
      idempotencyKey: "idem-modify-3",
      // @ts-expect-error — stay is not a field of ModifyReservationRequest; a date/room change must go through newQuoteRef.
      stay: { adults: 3 },
    };
    expect(withStay.idempotencyKey).toBe("idem-modify-3");
  });

  it("CancelReservationRequest / CancelReservationResult compile, and cancel also requires idempotencyKey", () => {
    const cancel: CancelReservationRequest = {
      hotelId: "hotel-1",
      integrationId: "int-1",
      externalReservationId: "ext-1",
      reason: null,
      idempotencyKey: "idem-cancel-1",
    };
    const cancelResult: CancelReservationResult = { status: "CANCELLED", externalReservationId: "ext-1", cancelledAt: "2026-09-01T10:00:00.000Z" };
    expect(cancel.idempotencyKey).toBeTruthy();
    expect(cancelResult.status).toBe("CANCELLED");
  });

  it("ModifyReservationResult compiles", () => {
    const modifyResult: ModifyReservationResult = {
      status: "CONFIRMED",
      externalReservationId: "ext-1",
      confirmationNumber: "CONF-1",
      providerStatus: "ok",
      totalPrice: null,
      updatedAt: "2026-09-01T10:00:00.000Z",
    };
    expect(modifyResult.status).toBe("CONFIRMED");
  });

  it("ReservationError covers every documented error code, including the three quote-invalidation codes, and keeps cause server-only by convention", () => {
    const codes: ReservationErrorCode[] = [
      "RESERVATION_NOT_FOUND",
      "OFFER_EXPIRED",
      "NO_LONGER_AVAILABLE",
      "PRICE_CHANGED",
      "INVALID_GUEST_DATA",
      "AUTH_ERROR",
      "RATE_LIMITED",
      "TIMEOUT",
      "PROVIDER_ERROR",
      "INVALID_RESPONSE",
      "IDEMPOTENCY_CONFLICT",
      "CONFIRMATION_REQUIRED",
    ];
    expect(codes).toContain("OFFER_EXPIRED");
    expect(codes).toContain("PRICE_CHANGED");
    expect(codes).toContain("NO_LONGER_AVAILABLE");
    const error: ReservationError = { code: "OFFER_EXPIRED", message: "L'offre a expiré.", hotelId: "hotel-1", retryable: false };
    expect(codes).toContain(error.code);
  });

  it("the four capability-aligned provider interfaces stay independent — an object can satisfy just one, never all four required", () => {
    const readOnly: ReservationReadProvider = {
      integrationId: "int-1",
      provider: "mews",
      getReservation: async (r) => ({
        status: "CONFIRMED",
        externalReservationId: r.externalReservationId,
        confirmationNumber: null,
        providerStatus: null,
        stay,
        guest,
        totalPrice: null,
      }),
    };
    const createOnly: ReservationCreateProvider = {
      integrationId: "int-1",
      provider: "mews",
      createReservation: async () => ({
        status: "PENDING",
        externalReservationId: null,
        confirmationNumber: null,
        providerStatus: null,
        totalPrice: null,
        createdAt: "2026-09-01T10:00:00.000Z",
      }),
    };
    const modifyOnly: ReservationModifyProvider = {
      integrationId: "int-1",
      provider: "mews",
      modifyReservation: async (r) => ({
        status: "CONFIRMED",
        externalReservationId: r.externalReservationId,
        confirmationNumber: null,
        providerStatus: null,
        totalPrice: null,
        updatedAt: "2026-09-01T10:00:00.000Z",
      }),
    };
    const cancelOnly: ReservationCancelProvider = {
      integrationId: "int-1",
      provider: "mews",
      cancelReservation: async (r) => ({ status: "CANCELLED", externalReservationId: r.externalReservationId, cancelledAt: null }),
    };
    expect([readOnly, createOnly, modifyOnly, cancelOnly]).toHaveLength(4);
  });
});
