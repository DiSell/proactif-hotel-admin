import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateSpaBookingResult, SpaAvailability } from "@/features/spa/booking";
import type { SpaBookingModelOutput, SpaBookingRequestState } from "./spaBookingFlow";

const mockCreateSpaBookingForChatbot = vi.fn<(...args: unknown[]) => Promise<CreateSpaBookingResult>>(async () => ({ ok: true, bookingId: "booking-1", status: "confirmed" }));
vi.mock("@/features/spa/booking", () => ({
  createSpaBookingForChatbot: (...args: unknown[]) => mockCreateSpaBookingForChatbot(...args),
}));

const ENABLED_AVAILABILITY: SpaAvailability = {
  enabled: true,
  date: "2026-09-15",
  pricePerPerson: 30,
  allowNonResidents: true,
  approvalMode: "auto",
  slots: [{ slotStart: "10:00", slotEnd: "12:00", capacity: 4, booked: 0, free: 4, bookable: true }],
};

const DISABLED_AVAILABILITY: SpaAvailability = { enabled: false, date: "2026-09-15", pricePerPerson: null, allowNonResidents: false, approvalMode: "auto", slots: [] };

const FULL_RESOLVED_REQUEST: SpaBookingRequestState = { bookingDate: "2026-09-15", slotStart: "10:00", partySize: 2 };

afterEach(() => {
  mockCreateSpaBookingForChatbot.mockClear();
  mockCreateSpaBookingForChatbot.mockResolvedValue({ ok: true, bookingId: "booking-1", status: "confirmed" });
});

const BASE_MODEL_OUTPUT: SpaBookingModelOutput = {
  spaBookingIntent: true,
  spaGuestName: "Marie",
  needsSpaGuestName: false,
  needsSpaGuestPhone: true,
  isNonResident: false,
  notes: null,
};

describe("isSpaBookingIntent", () => {
  it("[spa keywords fire]", async () => {
    const { isSpaBookingIntent } = await import("./spaBookingFlow");
    for (const message of ["Je voudrais réserver le spa", "avez-vous un hammam ?", "un massage en duo", "quel créneau est libre ?"]) {
      expect(isSpaBookingIntent(message), message).toBe(true);
    }
  });

  it("[unrelated messages never fire]", async () => {
    const { isSpaBookingIntent } = await import("./spaBookingFlow");
    for (const message of ["quel est le prix de la chambre ?", "bonjour", "2 personnes"]) {
      expect(isSpaBookingIntent(message), message).toBe(false);
    }
  });
});

describe("withSpaContinuationMarker / lastAssistantMessageContinuesSpaBooking", () => {
  it("[round trip] a reply tagged with the marker is recognized as a continuation", async () => {
    const { withSpaContinuationMarker, lastAssistantMessageContinuesSpaBooking } = await import("./spaBookingFlow");
    const tagged = withSpaContinuationMarker("Quel créneau souhaitez-vous ?");
    const history = [
      { role: "user" as const, content: "je veux réserver le spa" },
      { role: "assistant" as const, content: tagged },
      { role: "user" as const, content: "2 personnes" },
    ];
    expect(lastAssistantMessageContinuesSpaBooking(history)).toBe(true);
  });

  it("[the marker is invisible] never a visible substring like an HTML comment or a bracketed tag", async () => {
    const { withSpaContinuationMarker } = await import("./spaBookingFlow");
    const tagged = withSpaContinuationMarker("Bonjour");
    expect(tagged).not.toMatch(/<!--|\[|\]/);
  });

  it("[only the MOST RECENT assistant message is checked]", async () => {
    const { withSpaContinuationMarker, lastAssistantMessageContinuesSpaBooking } = await import("./spaBookingFlow");
    const history = [
      { role: "assistant" as const, content: withSpaContinuationMarker("ancien message") },
      { role: "user" as const, content: "autre chose" },
      { role: "assistant" as const, content: "Bonjour, comment puis-je vous aider ?" },
      { role: "user" as const, content: "merci" },
    ];
    expect(lastAssistantMessageContinuesSpaBooking(history)).toBe(false);
  });

  it("[no assistant message at all] returns false", async () => {
    const { lastAssistantMessageContinuesSpaBooking } = await import("./spaBookingFlow");
    expect(lastAssistantMessageContinuesSpaBooking([{ role: "user" as const, content: "bonjour" }])).toBe(false);
  });
});

describe("validateSpaBookingRequestState", () => {
  it("[valid values pass through]", async () => {
    const { validateSpaBookingRequestState } = await import("./spaBookingFlow");
    expect(validateSpaBookingRequestState({ bookingDate: "2026-09-15", slotStart: "10:00", partySize: 2 })).toEqual({
      bookingDate: "2026-09-15",
      slotStart: "10:00",
      partySize: 2,
    });
  });

  it("[malformed date is nulled out]", async () => {
    const { validateSpaBookingRequestState } = await import("./spaBookingFlow");
    expect(validateSpaBookingRequestState({ bookingDate: "15 septembre", slotStart: "10:00", partySize: 2 }).bookingDate).toBeNull();
  });

  it("[malformed slot is nulled out]", async () => {
    const { validateSpaBookingRequestState } = await import("./spaBookingFlow");
    expect(validateSpaBookingRequestState({ bookingDate: "2026-09-15", slotStart: "10h00", partySize: 2 }).slotStart).toBeNull();
  });

  it("[non-positive party size is nulled out]", async () => {
    const { validateSpaBookingRequestState } = await import("./spaBookingFlow");
    expect(validateSpaBookingRequestState({ bookingDate: "2026-09-15", slotStart: "10:00", partySize: 0 }).partySize).toBeNull();
  });
});

describe("processSpaBookingTurn", () => {
  it("[spa disabled] never engages, regardless of how complete the request looks", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "2 personnes",
      normalizedPhoneE164: "+33612345678",
      availability: DISABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome).toEqual({ replySuffix: null, phonePrompt: null, continuesFlow: false });
    expect(mockCreateSpaBookingForChatbot).not.toHaveBeenCalled();
  });

  it("[still collecting] missing date/slot/party size -> nothing to append, flow stays active", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "je voudrais réserver le spa",
      normalizedPhoneE164: null,
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: { bookingDate: null, slotStart: null, partySize: null },
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome).toEqual({ replySuffix: null, phonePrompt: null, continuesFlow: true });
  });

  it("[hallucinated slot] a slotStart absent from availability.slots is treated as unresolved, never passed to the RPC", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "16h",
      normalizedPhoneE164: "+33612345678",
      availability: ENABLED_AVAILABILITY, // only has a 10:00 slot
      resolvedRequest: { bookingDate: "2026-09-15", slotStart: "16:00", partySize: 2 },
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome.continuesFlow).toBe(true);
    expect(mockCreateSpaBookingForChatbot).not.toHaveBeenCalled();
  });

  it("[still needs a name] name required but not yet known -> flow stays active, no booking attempt", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "2 personnes",
      normalizedPhoneE164: null,
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: { ...BASE_MODEL_OUTPUT, spaGuestName: null, needsSpaGuestName: true },
    });
    expect(outcome).toEqual({ replySuffix: null, phonePrompt: null, continuesFlow: true });
    expect(mockCreateSpaBookingForChatbot).not.toHaveBeenCalled();
  });

  it("[real bug regression] no name is ever tolerated even if the model wrongly self-reports needsSpaGuestName: false — a phone given this turn must NOT create a booking without a name, regardless of what the model claims", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "0612345678",
      normalizedPhoneE164: "+33612345678",
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      // The model incorrectly claims it no longer needs a name, despite spaGuestName being null — this used to slip through and create a nameless booking.
      modelOutput: { ...BASE_MODEL_OUTPUT, spaGuestName: null, needsSpaGuestName: false },
    });
    expect(outcome.continuesFlow).toBe(true);
    expect(outcome.phonePrompt).toBeNull();
    expect(mockCreateSpaBookingForChatbot).not.toHaveBeenCalled();
  });

  it("[real bug regression] a blank/whitespace-only name is treated as no name at all", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "0612345678",
      normalizedPhoneE164: "+33612345678",
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: { ...BASE_MODEL_OUTPUT, spaGuestName: "   ", needsSpaGuestName: false },
    });
    expect(outcome.continuesFlow).toBe(true);
    expect(mockCreateSpaBookingForChatbot).not.toHaveBeenCalled();
  });

  it("[everything known except phone] shows the recap and the structured phone prompt — never claims the booking is confirmed", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "Marie",
      normalizedPhoneE164: null,
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome.continuesFlow).toBe(true);
    expect(outcome.phonePrompt).toEqual({
      pendingBooking: { bookingDate: "2026-09-15", slotStart: "10:00", partySize: 2, guestName: "Marie", isNonResident: false, notes: null },
    });
    expect(outcome.replySuffix).toMatch(/récapitulatif/i);
    expect(outcome.replySuffix).not.toMatch(/confirmée|enregistrée avec succès/i);
    expect(mockCreateSpaBookingForChatbot).not.toHaveBeenCalled();
  });

  it("[recap ordering] the full recap (date, créneau, nombre de personnes) is presented BEFORE the phone request sentence, never after", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "Marie",
      normalizedPhoneE164: null,
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    const text = outcome.replySuffix ?? "";
    const dateIndex = text.search(/Date :/);
    const slotIndex = text.search(/Créneau :/);
    const partySizeIndex = text.search(/Nombre de personnes :/);
    const phoneRequestIndex = text.search(/communiquant votre numéro/i);
    expect(dateIndex).toBeGreaterThan(-1);
    expect(slotIndex).toBeGreaterThan(dateIndex);
    expect(partySizeIndex).toBeGreaterThan(slotIndex);
    expect(phoneRequestIndex).toBeGreaterThan(partySizeIndex);
  });

  it("[explicit, unambiguous confirmation wording] the recap states that SENDING THE PHONE NUMBER definitively confirms the booking, and that it is NOT yet registered", async () => {
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "Marie",
      normalizedPhoneE164: null,
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome.replySuffix).toMatch(/n'est PAS encore enregistrée/i);
    expect(outcome.replySuffix).toMatch(/en communiquant votre numéro de téléphone.*vous confirmez définitivement/i);
  });

  it("[phone given this turn] creates the booking immediately — no separate 'oui' step", async () => {
    mockCreateSpaBookingForChatbot.mockResolvedValueOnce({ ok: true, bookingId: "booking-1", status: "confirmed" });
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "0612345678",
      normalizedPhoneE164: "+33612345678",
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(mockCreateSpaBookingForChatbot).toHaveBeenCalledWith(
      expect.objectContaining({ hotelId: "h1", conversationId: "c1", guestPhoneE164: "+33612345678", bookingDate: "2026-09-15", slotStart: "10:00", partySize: 2 }),
      undefined
    );
    expect(outcome.replaceReply).toBe(true);
    expect(outcome.continuesFlow).toBe(false);
    expect(outcome.replySuffix).toMatch(/confirmée/i);
  });

  it("[booking fails — slot just filled up] continuesFlow stays true so the guest can pick another slot", async () => {
    mockCreateSpaBookingForChatbot.mockResolvedValueOnce({ ok: false, code: "slot_full" });
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "0612345678",
      normalizedPhoneE164: "+33612345678",
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome.continuesFlow).toBe(true);
    expect(outcome.replaceReply).toBe(true);
  });

  it("[slot_full with real alternatives] lists the OTHER bookable slots computed by getSpaAvailability, never invented ones", async () => {
    mockCreateSpaBookingForChatbot.mockResolvedValueOnce({ ok: false, code: "slot_full" });
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const availabilityWithAlternative: SpaAvailability = {
      ...ENABLED_AVAILABILITY,
      slots: [
        { slotStart: "10:00", slotEnd: "12:00", capacity: 4, booked: 4, free: 0, bookable: false },
        { slotStart: "12:00", slotEnd: "14:00", capacity: 4, booked: 0, free: 4, bookable: true },
      ],
    };
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "0612345678",
      normalizedPhoneE164: "+33612345678",
      availability: availabilityWithAlternative,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome.replySuffix).toContain("12:00 - 14:00");
    expect(outcome.replySuffix).not.toMatch(/confirmée/i);
  });

  it.each([
    ["outside_window" as const, /date plus proche/i],
    ["min_notice" as const, /créneau plus tard|autre date/i],
    ["invalid_slot" as const, /en choisir un autre/i],
    ["non_resident_not_allowed" as const, /réception/i],
    ["not_enabled" as const, /contacter directement/i],
    ["error" as const, /réessayer|contacter/i],
  ])("[business error %s] never claims success, and proposes an actionable next step", async (code, expectedHint) => {
    mockCreateSpaBookingForChatbot.mockResolvedValueOnce({ ok: false, code });
    const { processSpaBookingTurn } = await import("./spaBookingFlow");
    const outcome = await processSpaBookingTurn({
      hotelId: "h1",
      conversationId: "c1",
      message: "0612345678",
      normalizedPhoneE164: "+33612345678",
      availability: ENABLED_AVAILABILITY,
      resolvedRequest: FULL_RESOLVED_REQUEST,
      modelOutput: BASE_MODEL_OUTPUT,
    });
    expect(outcome.replySuffix).not.toMatch(/est confirmée|réservation confirmée/i);
    expect(outcome.replySuffix).toMatch(expectedHint);
    expect(outcome.replaceReply).toBe(true);
  });
});

describe("submitStructuredSpaBookingPhone", () => {
  it("[slot no longer available] never calls the RPC, returns a clear error", async () => {
    const { submitStructuredSpaBookingPhone } = await import("./spaBookingFlow");
    const result = await submitStructuredSpaBookingPhone({
      hotelId: "h1",
      conversationId: "c1",
      phoneE164: "+33612345678",
      pendingBooking: { bookingDate: "2026-09-15", slotStart: "16:00", partySize: 2, guestName: "Marie", isNonResident: false, notes: null },
      availability: ENABLED_AVAILABILITY, // no 16:00 slot
      supabase: {} as never,
    });
    expect(result.ok).toBe(false);
    expect(mockCreateSpaBookingForChatbot).not.toHaveBeenCalled();
  });

  it("[valid slot] calls createSpaBookingForChatbot and returns its outcome as a message", async () => {
    mockCreateSpaBookingForChatbot.mockResolvedValueOnce({ ok: true, bookingId: "booking-2", status: "confirmed" });
    const { submitStructuredSpaBookingPhone } = await import("./spaBookingFlow");
    const result = await submitStructuredSpaBookingPhone({
      hotelId: "h1",
      conversationId: "c1",
      phoneE164: "+33612345678",
      pendingBooking: { bookingDate: "2026-09-15", slotStart: "10:00", partySize: 2, guestName: "Marie", isNonResident: false, notes: null },
      availability: ENABLED_AVAILABILITY,
      supabase: {} as never,
    });
    expect(result.ok).toBe(true);
    expect(mockCreateSpaBookingForChatbot).toHaveBeenCalledWith(expect.objectContaining({ guestPhoneE164: "+33612345678" }), {});
  });
});
