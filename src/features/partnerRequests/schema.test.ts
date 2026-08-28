import { describe, expect, it } from "vitest";
import { applyPartnerRequestCommandSchema, createPartnerRequestSchema } from "./schema";

// Zod v4's z.string().uuid() enforces the RFC 4122 variant nibble (must be
// 8/9/a/b) — these fixtures set it explicitly so they pass strict UUID
// validation, unlike a naive "all same digit" placeholder.
const VALID_UUID = "11111111-1111-1111-8111-111111111111";
const VALID_UUID_2 = "22222222-2222-2222-8222-222222222222";
const VALID_UUID_3 = "33333333-3333-3333-8333-333333333333";

function validCreateInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    hotelId: VALID_UUID,
    partnerId: VALID_UUID_2,
    conversationId: VALID_UUID_3,
    guestName: "Alice Client",
    guestPhoneE164: "+33612345678",
    requestCategory: "restaurant",
    requestedDate: "2026-09-01",
    requestedTime: "20:00",
    partySize: 2,
    details: "Table pour deux",
    ...overrides,
  };
}

describe("createPartnerRequestSchema", () => {
  it("[valid] accepts a well-formed input", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput()).success).toBe(true);
  });

  it("[minimal] accepts null/omitted optional fields", () => {
    const result = createPartnerRequestSchema.safeParse({
      hotelId: VALID_UUID,
      partnerId: VALID_UUID_2,
      conversationId: VALID_UUID_3,
      guestName: null,
      guestPhoneE164: null,
      requestCategory: "restaurant",
      requestedDate: null,
      requestedTime: null,
      partySize: null,
      details: null,
    });
    expect(result.success).toBe(true);
  });

  it("[malformed hotelId] rejected", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ hotelId: "not-a-uuid" })).success).toBe(false);
  });

  it("[malformed partnerId] rejected", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ partnerId: "not-a-uuid" })).success).toBe(false);
  });

  it("[malformed conversationId] rejected", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ conversationId: "not-a-uuid" })).success).toBe(false);
  });

  it("[empty requestCategory] rejected", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ requestCategory: "" })).success).toBe(false);
  });

  it("[guestPhoneE164 not normalized — rejected, never fixed up] a raw national number without a leading + is rejected, not silently normalized", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ guestPhoneE164: "0612345678" })).success).toBe(false);
  });

  it("[guestPhoneE164 malformed +] rejected", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ guestPhoneE164: "+abc" })).success).toBe(false);
  });

  it("[partySize zero or negative] rejected", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ partySize: 0 })).success).toBe(false);
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ partySize: -1 })).success).toBe(false);
  });

  it("[details too long] rejected", () => {
    expect(createPartnerRequestSchema.safeParse(validCreateInput({ details: "x".repeat(2001) })).success).toBe(false);
  });
});

function validCommandInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    partnerRequestId: VALID_UUID,
    hotelId: VALID_UUID_2,
    command: "request_guest_confirmation",
    message: null,
    metadata: null,
    ...overrides,
  };
}

describe("applyPartnerRequestCommandSchema", () => {
  it("[valid] accepts a well-formed command", () => {
    expect(applyPartnerRequestCommandSchema.safeParse(validCommandInput()).success).toBe(true);
  });

  it("[every one of the 14 validated commands is individually accepted]", () => {
    const commands = [
      "request_guest_confirmation",
      "guest_confirm",
      "partner_delivery_succeeded",
      "partner_delivery_failed",
      "partner_accept",
      "partner_reject",
      "partner_propose_alternative",
      "guest_accept_alternative",
      "guest_reject_alternative",
      "guest_notification_succeeded",
      "guest_notification_failed",
      "cancel_by_guest",
      "cancel_by_hotel",
      "cancel_by_system",
    ];
    expect(commands).toHaveLength(14);
    for (const command of commands) {
      expect(applyPartnerRequestCommandSchema.safeParse(validCommandInput({ command })).success, `command=${command}`).toBe(true);
    }
  });

  it("[unknown command] rejected before ever reaching the RPC", () => {
    expect(applyPartnerRequestCommandSchema.safeParse(validCommandInput({ command: "not_a_real_command" })).success).toBe(false);
  });

  it("[event_type/actor_type/status are not accepted fields at all] extra properties are simply ignored by Zod's default parsing, never smuggled into the validated output", () => {
    const result = applyPartnerRequestCommandSchema.safeParse({
      ...validCommandInput(),
      eventType: "partner_accepted",
      actorType: "partner",
      status: "accepted",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("eventType");
      expect(result.data).not.toHaveProperty("actorType");
      expect(result.data).not.toHaveProperty("status");
    }
  });

  it("[malformed partnerRequestId] rejected", () => {
    expect(applyPartnerRequestCommandSchema.safeParse(validCommandInput({ partnerRequestId: "not-a-uuid" })).success).toBe(false);
  });

  it("[message too long] rejected", () => {
    expect(applyPartnerRequestCommandSchema.safeParse(validCommandInput({ message: "x".repeat(2001) })).success).toBe(false);
  });
});
