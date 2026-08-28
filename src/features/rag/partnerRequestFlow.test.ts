import { afterEach, describe, expect, it, vi } from "vitest";
import type { HotelPartner } from "@/types/database";
import type { PartnerRequest } from "@/features/partnerRequests/types";
import type { WhatsAppSendResult } from "@/lib/notifications/whatsapp/types";

const mockCreate = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "req-new");
const mockApplyCommand = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
vi.mock("@/features/partnerRequests/chatbotService", () => ({
  createPartnerRequestForChatbot: (...args: unknown[]) => mockCreate(...args),
  applyPartnerRequestCommandForChatbot: (...args: unknown[]) => mockApplyCommand(...args),
}));

const mockGetActiveRequest = vi.fn<(...args: unknown[]) => Promise<PartnerRequest | null>>(async () => null);
const mockGetGuestPhone = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null);
const mockGetPartnerRequestById = vi.fn<(...args: unknown[]) => Promise<PartnerRequest | null>>(async () => ({ id: "req-1", status: "pending_confirmation" }) as PartnerRequest);
const mockHasGuestConfirmed = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => false);
vi.mock("@/features/partnerRequests/queries", () => ({
  getActivePartnerRequestForConversation: (...args: unknown[]) => mockGetActiveRequest(...args),
  getGuestPhoneForPartnerRequest: (...args: unknown[]) => mockGetGuestPhone(...args),
  getPartnerRequestById: (...args: unknown[]) => mockGetPartnerRequestById(...args),
  hasGuestConfirmedEvent: (...args: unknown[]) => mockHasGuestConfirmed(...args),
}));

const mockDeliverPartnerRequest = vi.fn<(...args: unknown[]) => Promise<WhatsAppSendResult>>(async () => ({ ok: true, providerMessageId: "wamid.test" }));
const mockGetLatestDeliveryStatus = vi.fn<(...args: unknown[]) => Promise<"queued" | "sending" | "sent" | "failed" | "unknown" | null>>(async () => null);
const mockReconcileStaleSending = vi.fn(async (delivery: { status: "queued" | "sending" | "sent" | "failed" | "unknown" }) => delivery.status);
vi.mock("@/features/partnerRequests/deliveryService", () => ({
  deliverPartnerRequest: (...args: unknown[]) => mockDeliverPartnerRequest(...args),
  getLatestPartnerRequestDelivery: async (...args: unknown[]) => {
    const status = await mockGetLatestDeliveryStatus(...args);
    return status ? { id: "delivery-1", status, updatedAt: "2026-08-29T00:00:00.000Z" } : null;
  },
  reconcileStaleSendingDelivery: (...args: Parameters<typeof mockReconcileStaleSending>) => mockReconcileStaleSending(...args),
}));

let loadPartnersResult: HotelPartner[] = [];
const mockLoadActiveHotelPartners = vi.fn<(...args: unknown[]) => Promise<HotelPartner[]>>(async () => loadPartnersResult);
vi.mock("./partners", () => ({
  loadActiveHotelPartners: (...args: unknown[]) => mockLoadActiveHotelPartners(...args),
}));

afterEach(() => {
  // .mockReset() (not just .mockClear()) on every mock that ever uses a
  // *Once() queued implementation in a test below — .mockClear() alone
  // would leave an unconsumed queued rejection to leak into a later,
  // unrelated test (a real bug caught during this task's own test-writing).
  mockCreate.mockReset();
  mockCreate.mockImplementation(async () => "req-new");
  mockApplyCommand.mockReset();
  mockApplyCommand.mockImplementation(async () => undefined);
  mockHasGuestConfirmed.mockReset();
  mockHasGuestConfirmed.mockImplementation(async () => false);
  mockGetActiveRequest.mockReset();
  mockGetActiveRequest.mockImplementation(async () => null);
  mockGetGuestPhone.mockReset();
  mockGetGuestPhone.mockImplementation(async () => null);
  mockGetPartnerRequestById.mockReset();
  mockGetPartnerRequestById.mockImplementation(async () => ({ id: "req-1", status: "pending_confirmation" }) as PartnerRequest);
  mockDeliverPartnerRequest.mockReset();
  mockDeliverPartnerRequest.mockImplementation(async () => ({ ok: true as const, providerMessageId: "wamid.test" }));
  mockGetLatestDeliveryStatus.mockReset();
  mockGetLatestDeliveryStatus.mockImplementation(async () => null);
  mockReconcileStaleSending.mockClear();
  mockLoadActiveHotelPartners.mockClear();
  loadPartnersResult = [];
});

function fakePartner(overrides: Partial<HotelPartner> = {}): HotelPartner {
  return {
    id: "partner-1",
    hotel_id: "hotel-a",
    name: "Le Bistrot",
    category: "restaurant",
    description: null,
    address: null,
    phone: null,
    opening_hours: null,
    website_url: null,
    booking_url: null,
    is_active: true,
    priority: 0,
    email: null,
    consent_status: "accepted",
    consent_token_hash: null,
    consent_requested_at: null,
    consent_responded_at: null,
    request_phone_e164: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as HotelPartner;
}

function fakeModelOutput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    partnerRequestIntent: true,
    partnerId: "partner-1",
    requestedDate: "2026-09-01",
    requestedTime: "20:00",
    partySize: 2,
    details: "Table calme",
    guestName: "Alice",
    needsGuestName: false,
    needsGuestPhone: false,
    confirmPartnerRequest: false,
    ...overrides,
  };
}

describe("isExplicitConfirmation — no implicit confirmation", () => {
  it("[explicit affirmatives] recognized", async () => {
    const { isExplicitConfirmation } = await import("./partnerRequestFlow");
    for (const message of ["Oui", "yes please", "Je confirme", "D'accord, envoyez", "ok", "allez-y"]) {
      expect(isExplicitConfirmation(message), message).toBe(true);
    }
  });

  it("[ambiguous/unrelated replies] never treated as confirmation", async () => {
    const { isExplicitConfirmation } = await import("./partnerRequestFlow");
    for (const message of ["Peut-être plus tard", "Combien ça coûte ?", "Autre chose sinon ?", "Non merci"]) {
      expect(isExplicitConfirmation(message), message).toBe(false);
    }
  });
});

describe("processPartnerRequestTurn — no active request yet, no phone this turn", () => {
  it("[needsGuestName] no phone prompt yet — name must come first", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "Je voudrais réserver une table",
      normalizedPhoneE164: null,
      activePartnerRequest: null,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ needsGuestName: true, needsGuestPhone: true }),
    });

    expect(result).toEqual({ replySuffix: null, phonePrompt: null });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("[needsGuestPhone, no phone yet] emits the structured phonePrompt signal, no RPC call, no reply text", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "Je voudrais réserver une table",
      normalizedPhoneE164: null,
      activePartnerRequest: null,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ needsGuestPhone: true }),
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyCommand).not.toHaveBeenCalled();
    expect(result.replySuffix).toBeNull();
    expect(result.phonePrompt).toEqual({
      partnerName: "Le Bistrot",
      pendingRequest: {
        partnerId: "partner-1",
        requestedDate: "2026-09-01",
        requestedTime: "20:00",
        partySize: 2,
        details: "Table calme",
        guestName: "Alice",
      },
    });
  });

  it("[neither needsGuestPhone nor a phone this turn] nothing to do yet", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "C'est pour ce soir",
      normalizedPhoneE164: null,
      activePartnerRequest: null,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ needsGuestPhone: false }),
    });

    expect(result).toEqual({ replySuffix: null, phonePrompt: null });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("[unknown/foreign partnerId] never trusted, even with everything else ready — no phonePrompt either", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "+33612345678",
      normalizedPhoneE164: "+33612345678",
      activePartnerRequest: null,
      allActivePartners: [fakePartner({ id: "partner-1" })],
      modelOutput: fakeModelOutput({ partnerId: "partner-does-not-exist" }),
    });

    expect(result).toEqual({ replySuffix: null, phonePrompt: null });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("processPartnerRequestTurn — free-text phone path (same turn)", () => {
  it("[everything ready] creates via create_partner_request RPC, then immediately request_guest_confirmation, never a direct table write, returns a recap mentioning the mandatory phone-usage sentence and the exact confirmation question", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "Mon numéro est +33612345678",
      normalizedPhoneE164: "+33612345678",
      activePartnerRequest: null,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput(),
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        hotelId: "hotel-a",
        partnerId: "partner-1",
        conversationId: "conv-1",
        guestName: "Alice",
        guestPhoneE164: "+33612345678",
        requestCategory: "restaurant",
        requestedDate: "2026-09-01",
        requestedTime: "20:00",
        partySize: 2,
        details: "Table calme",
      }),
      undefined
    );
    expect(mockApplyCommand).toHaveBeenCalledWith("req-new", "hotel-a", "request_guest_confirmation", undefined);
    expect(result.phonePrompt).toBeNull();
    expect(result.replySuffix).toMatch(/Le Bistrot/);
    expect(result.replySuffix).toMatch(/Votre numéro sera utilisé uniquement pour transmettre cette demande/);
    expect(result.replySuffix).toMatch(/Souhaitez-vous envoyer cette demande \?/);
    expect(result.replySuffix).toMatch(/en attente d'envoi/);
    expect(result.replySuffix).not.toMatch(/réservation confirmée/i);
    expect(result.replySuffix).not.toMatch(/612345678/); // masked, never the raw number
  });

  it("[phone this turn wins even if needsGuestPhone still true] the free-text safety net still works", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "+33612345678",
      normalizedPhoneE164: "+33612345678",
      activePartnerRequest: null,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ needsGuestPhone: true }),
    });

    expect(mockCreate).toHaveBeenCalled();
    expect(result.replySuffix).toMatch(/Le Bistrot/);
    expect(result.phonePrompt).toBeNull();
  });

  it("[category comes from the resolved partner, never the model] request_category is always partner.category", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "+33612345678",
      normalizedPhoneE164: "+33612345678",
      activePartnerRequest: null,
      allActivePartners: [fakePartner({ category: "transport" })],
      modelOutput: fakeModelOutput(),
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ requestCategory: "transport" }), undefined);
  });

  it("[no delivery command ever called]", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "+33612345678",
      normalizedPhoneE164: "+33612345678",
      activePartnerRequest: null,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput(),
    });

    for (const call of mockApplyCommand.mock.calls) {
      expect(call[2]).not.toBe("partner_delivery_succeeded");
      expect(call[2]).not.toBe("partner_delivery_failed");
    }
  });

  it("[concurrent race already advanced the row] request_guest_confirmation failing because a concurrent call already did it is NOT a hard failure — the recap is still returned", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    mockApplyCommand.mockRejectedValueOnce(new Error("command not allowed from status pending_confirmation"));
    mockGetActiveRequest.mockResolvedValueOnce({ id: "req-new", status: "pending_confirmation" } as PartnerRequest);

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "+33612345678",
      normalizedPhoneE164: "+33612345678",
      activePartnerRequest: null,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput(),
      supabase: {} as never,
    });

    expect(result.replySuffix).toMatch(/Le Bistrot/);
    expect(mockGetActiveRequest).toHaveBeenCalledWith("hotel-a", "conv-1", {});
  });

  it("[genuine failure, not the known race] re-throws when the re-read doesn't show pending_confirmation for the same row", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    mockApplyCommand.mockRejectedValueOnce(new Error("permission denied"));
    mockGetActiveRequest.mockResolvedValueOnce(null);

    await expect(
      processPartnerRequestTurn({
        hotelId: "hotel-a",
        conversationId: "conv-1",
        message: "+33612345678",
        normalizedPhoneE164: "+33612345678",
        activePartnerRequest: null,
        allActivePartners: [fakePartner()],
        modelOutput: fakeModelOutput(),
        supabase: {} as never,
      })
    ).rejects.toThrow("permission denied");
  });
});

describe("processPartnerRequestTurn — active request pending_confirmation", () => {
  const activeRequest = { id: "req-1", partner_id: "partner-1", status: "pending_confirmation" } as PartnerRequest;

  it("[model says confirm, message not explicit] no confirmation applied — no implicit confirmation", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "peut-être",
      normalizedPhoneE164: null,
      activePartnerRequest: activeRequest,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }),
    });

    expect(result).toEqual({ replySuffix: null, phonePrompt: null });
    expect(mockApplyCommand).not.toHaveBeenCalled();
  });

  it("[explicit yes + model agrees] records guest_confirm before delivery and returns deterministic success text", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "Oui, je confirme",
      normalizedPhoneE164: null,
      activePartnerRequest: activeRequest,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }),
      supabase: {} as never,
    });

    expect(mockApplyCommand).toHaveBeenCalledWith("req-1", "hotel-a", "guest_confirm", {});
    expect(mockApplyCommand.mock.invocationCallOrder[0]).toBeLessThan(mockDeliverPartnerRequest.mock.invocationCallOrder[0]);
    expect(mockDeliverPartnerRequest).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(result.replySuffix).toMatch(/bien été transmise au partenaire/);
    expect(result.replySuffix).not.toMatch(/réservation confirmée/i);
    expect(result.replySuffix).not.toMatch(/a accepté/i);
    expect(result.phonePrompt).toBeNull();
  });

  it("[never recreates a request while one is already active]", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "Oui",
      normalizedPhoneE164: "+33699999999",
      activePartnerRequest: activeRequest,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true, partnerRequestIntent: true }),
      supabase: {} as never,
    });

    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, error: "provider_not_configured", attempted: false }, /service de transmission.*pas encore disponible/],
    [{ ok: false, error: "template_not_configured", attempted: false }, /service de transmission.*pas encore disponible/],
    [{ ok: false, error: "partner_not_eligible", attempted: false }, /ne peut pas recevoir de demande directement/],
    [{ ok: false, error: "provider_error", attempted: true, certainty: "not_sent" }, /pas pu la transmettre/],
    [{ ok: false, error: "provider_unknown", attempted: true, certainty: "unknown" }, /en cours de vérification/],
  ] as const)("[delivery result %o] maps to a deterministic non-technical message", async (deliveryResult, expected) => {
    mockDeliverPartnerRequest.mockResolvedValueOnce(deliveryResult);
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a", conversationId: "conv-1", message: "Oui", normalizedPhoneE164: null,
      activePartnerRequest: activeRequest, allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }), supabase: {} as never,
    });
    expect(result.replySuffix).toMatch(expected);
    expect(result.replySuffix).not.toMatch(/provider_|WHATSAPP_|Meta|réservation confirmée/i);
  });

  it.each([
    ["queued", /transmission.*en cours/],
    ["sending", /transmission.*en cours/],
    ["failed", /pas pu la transmettre/],
    ["unknown", /en cours de vérification/],
    ["sent", /bien été transmise/],
  ] as const)("[persisted delivery %s] is reused without any retry", async (status, expected) => {
    mockGetLatestDeliveryStatus.mockResolvedValueOnce(status);
    mockHasGuestConfirmed.mockResolvedValueOnce(true);
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a", conversationId: "conv-1", message: "Oui", normalizedPhoneE164: null,
      activePartnerRequest: activeRequest, allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }), supabase: {} as never,
    });
    expect(result.replySuffix).toMatch(expected);
    expect(mockApplyCommand).not.toHaveBeenCalled();
    expect(mockDeliverPartnerRequest).not.toHaveBeenCalled();
  });

  it("[already sent_to_partner] answers already transmitted without another delivery", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a", conversationId: "conv-1", message: "Oui", normalizedPhoneE164: null,
      activePartnerRequest: { ...activeRequest, status: "sent_to_partner" }, allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }), supabase: {} as never,
    });
    expect(result.replySuffix).toMatch(/bien été transmise/);
    expect(mockDeliverPartnerRequest).not.toHaveBeenCalled();
  });

  it("[lost HTTP response retry] existing guest confirmation plus unknown delivery never retries", async () => {
    mockHasGuestConfirmed.mockResolvedValueOnce(true);
    mockGetLatestDeliveryStatus.mockResolvedValueOnce("unknown");
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a", conversationId: "conv-1", message: "Oui", normalizedPhoneE164: null,
      activePartnerRequest: activeRequest, allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }), supabase: {} as never,
    });
    expect(result.replySuffix).toMatch(/en cours de vérification/);
    expect(mockApplyCommand).not.toHaveBeenCalled();
    expect(mockDeliverPartnerRequest).not.toHaveBeenCalled();
  });

  it("[stale sending] reconciles to unknown and shows verification without provider retry", async () => {
    mockHasGuestConfirmed.mockResolvedValueOnce(true);
    mockGetLatestDeliveryStatus.mockResolvedValueOnce("sending");
    mockReconcileStaleSending.mockResolvedValueOnce("unknown");
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a", conversationId: "conv-1", message: "Oui", normalizedPhoneE164: null,
      activePartnerRequest: activeRequest, allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }), supabase: {} as never,
    });
    expect(result.replySuffix).toMatch(/en cours de vérification/);
    expect(mockReconcileStaleSending).toHaveBeenCalledTimes(1);
    expect(mockDeliverPartnerRequest).not.toHaveBeenCalled();
    expect(mockApplyCommand).not.toHaveBeenCalled();
  });

  it("[double yes / frontend retry] the second turn reuses the persisted sent delivery", async () => {
    mockGetLatestDeliveryStatus.mockResolvedValueOnce(null).mockResolvedValueOnce("sent");
    mockHasGuestConfirmed.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockGetPartnerRequestById.mockResolvedValue(({ id: "req-1", status: "pending_confirmation" }) as PartnerRequest);
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    const params = {
      hotelId: "hotel-a", conversationId: "conv-1", message: "Oui", normalizedPhoneE164: null,
      activePartnerRequest: activeRequest, allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }), supabase: {} as never,
    };
    const first = await processPartnerRequestTurn(params);
    const second = await processPartnerRequestTurn(params);
    expect(first.replySuffix).toMatch(/bien été transmise/);
    expect(second.replySuffix).toMatch(/bien été transmise/);
    expect(mockDeliverPartnerRequest).toHaveBeenCalledTimes(1);
    expect(mockApplyCommand).toHaveBeenCalledTimes(1);
  });

  it("[success projection reload] final sent_to_partner projection decides the message", async () => {
    mockGetPartnerRequestById
      .mockResolvedValueOnce(({ id: "req-1", status: "pending_confirmation" }) as PartnerRequest)
      .mockResolvedValueOnce(({ id: "req-1", status: "sent_to_partner" }) as PartnerRequest);
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");
    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a", conversationId: "conv-1", message: "Oui", normalizedPhoneE164: null,
      activePartnerRequest: activeRequest, allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ confirmPartnerRequest: true }), supabase: {} as never,
    });
    expect(mockGetPartnerRequestById).toHaveBeenCalledTimes(2);
    expect(result.replySuffix).toMatch(/bien été transmise/);
    expect(result.replySuffix).not.toMatch(/réservation confirmée|c’est réservé|a accepté/i);
  });
});

describe("processPartnerRequestTurn — resuming a partial draft (create succeeded, request_guest_confirmation didn't)", () => {
  const draftRequest = {
    id: "req-1",
    partner_id: "partner-1",
    status: "draft",
    requested_date: "2026-09-01",
    requested_time: "20:00",
    party_size: 2,
    details: "Table calme",
    guest_name: "Alice",
  } as PartnerRequest;

  it("[resumes, never recreates] calls request_guest_confirmation directly — never create_partner_request a second time", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "allô ?",
      normalizedPhoneE164: null,
      activePartnerRequest: draftRequest,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput(),
    });

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyCommand).toHaveBeenCalledWith("req-1", "hotel-a", "request_guest_confirmation", undefined);
    expect(result.replySuffix).toMatch(/Le Bistrot/);
    expect(result.replySuffix).toMatch(/Souhaitez-vous envoyer cette demande \?/);
  });

  it("[uses the DB row's own stored fields] never the current turn's modelOutput — the draft may have been created several turns ago", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "allô ?",
      normalizedPhoneE164: null,
      activePartnerRequest: draftRequest,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput({ requestedDate: "1999-01-01", guestName: "Someone Else", details: "unrelated" }),
    });

    expect(result.replySuffix).toMatch(/Alice/);
    expect(result.replySuffix).toMatch(/Table calme/);
    expect(result.replySuffix).not.toMatch(/Someone Else/);
    expect(result.replySuffix).not.toMatch(/unrelated/);
  });

  it("[never redisplays a phone] guest_phone_e164 isn't in the projection this reads — the recap never claims/shows one", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "allô ?",
      normalizedPhoneE164: null,
      activePartnerRequest: draftRequest,
      allActivePartners: [fakePartner()],
      modelOutput: fakeModelOutput(),
    });

    expect(result.replySuffix).not.toMatch(/Téléphone/);
  });

  it("[partner no longer valid] left as-is rather than guessed at", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    const result = await processPartnerRequestTurn({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      message: "allô ?",
      normalizedPhoneE164: null,
      activePartnerRequest: draftRequest,
      allActivePartners: [], // partner deactivated/consent revoked since creation
      modelOutput: fakeModelOutput(),
    });

    expect(result).toEqual({ replySuffix: null, phonePrompt: null });
    expect(mockApplyCommand).not.toHaveBeenCalled();
  });
});

describe("processPartnerRequestTurn — active request in a non-actionable status", () => {
  it("[sent_to_partner / alternative_proposed] out of scope this phase, no action taken", async () => {
    const { processPartnerRequestTurn } = await import("./partnerRequestFlow");

    for (const status of ["sent_to_partner", "alternative_proposed"] as const) {
      const result = await processPartnerRequestTurn({
        hotelId: "hotel-a",
        conversationId: "conv-1",
        message: "des nouvelles ?",
        normalizedPhoneE164: null,
        activePartnerRequest: { id: "req-1", partner_id: "partner-1", status } as PartnerRequest,
        allActivePartners: [fakePartner()],
        modelOutput: fakeModelOutput(),
      });
      expect(result).toEqual({ replySuffix: null, phonePrompt: null });
    }
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyCommand).not.toHaveBeenCalled();
  });
});

describe("submitStructuredGuestPhone — no active request yet (happy path)", () => {
  it("[creates via the shared finalize path] never a direct table write, phone included from the very first write", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    loadPartnersResult = [fakePartner()];

    const result = await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33612345678",
      pendingRequest: {
        partnerId: "partner-1",
        requestedDate: "2026-09-01",
        requestedTime: "20:00",
        partySize: 2,
        details: "Table calme",
        guestName: "Alice",
      },
      supabase: {} as never,
    });

    expect(result.ok).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ guestPhoneE164: "+33612345678" }), {});
    expect(mockApplyCommand).toHaveBeenCalledWith("req-new", "hotel-a", "request_guest_confirmation", {});
    if (result.ok) expect(result.message).toMatch(/Le Bistrot/);
  });

  it("[partner no longer available] rejected before any RPC call", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    loadPartnersResult = [];

    const result = await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33612345678",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
      supabase: {} as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("partner_unavailable");
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("submitStructuredGuestPhone — double submit / idempotence", () => {
  it("[pending_confirmation, same phone] idempotent success, no new create, no new command", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    mockGetActiveRequest.mockResolvedValueOnce({ id: "req-1", partner_id: "partner-1", status: "pending_confirmation" } as PartnerRequest);
    mockGetGuestPhone.mockResolvedValueOnce("+33612345678");

    const result = await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33612345678",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
      supabase: {} as never,
    });

    expect(result.ok).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyCommand).not.toHaveBeenCalled();
  });

  it("[draft, same phone] resumes by calling request_guest_confirmation, never recreates", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    mockGetActiveRequest.mockResolvedValueOnce({
      id: "req-1",
      partner_id: "partner-1",
      status: "draft",
      requested_date: "2026-09-01",
      requested_time: "20:00",
      party_size: 2,
      details: "Table calme",
      guest_name: "Alice",
    } as PartnerRequest);
    mockGetGuestPhone.mockResolvedValueOnce("+33612345678");
    loadPartnersResult = [fakePartner()];

    const result = await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33612345678",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
      supabase: {} as never,
    });

    expect(result.ok).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyCommand).toHaveBeenCalledWith("req-1", "hotel-a", "request_guest_confirmation", {});
  });

  it("[different phone submitted] never a silent overwrite — explicit rejection instead", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    mockGetActiveRequest.mockResolvedValueOnce({ id: "req-1", partner_id: "partner-1", status: "pending_confirmation" } as PartnerRequest);
    mockGetGuestPhone.mockResolvedValueOnce("+33611111111");

    const result = await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33622222222",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
      supabase: {} as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("phone_mismatch");
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockApplyCommand).not.toHaveBeenCalled();
  });

  it("[active request in an unsupported state] rejected, never guessed at", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    mockGetActiveRequest.mockResolvedValueOnce({ id: "req-1", partner_id: "partner-1", status: "sent_to_partner" } as PartnerRequest);

    const result = await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33612345678",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
      supabase: {} as never,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unsupported_state");
    expect(mockGetGuestPhone).not.toHaveBeenCalled();
  });

  it("[no delivery command ever called]", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    loadPartnersResult = [fakePartner()];

    await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33612345678",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
      supabase: {} as never,
    });

    for (const call of mockApplyCommand.mock.calls) {
      expect(call[2]).not.toBe("partner_delivery_succeeded");
      expect(call[2]).not.toBe("partner_delivery_failed");
    }
  });

  it("[tenant isolation] getActivePartnerRequestForConversation is always called with the exact hotelId/conversationId given", async () => {
    const { submitStructuredGuestPhone } = await import("./partnerRequestFlow");
    loadPartnersResult = [fakePartner()];

    await submitStructuredGuestPhone({
      hotelId: "hotel-a",
      conversationId: "conv-1",
      phoneE164: "+33612345678",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
      supabase: {} as never,
    });

    expect(mockGetActiveRequest).toHaveBeenCalledWith("hotel-a", "conv-1", {});
  });
});
