import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "chatbotService.ts"), "utf8");

function fakeSupabase(rpcResult: { data: unknown; error: { message: string; code?: string } | null }) {
  const rpc = vi.fn(async () => rpcResult);
  return { rpc };
}

const mockGetActiveRequest = vi.fn<(hotelId: string, conversationId: string, supabase: unknown) => Promise<unknown>>(async () => null);
vi.mock("./queries", () => ({
  getActivePartnerRequestForConversation: (hotelId: string, conversationId: string, supabase: unknown) =>
    mockGetActiveRequest(hotelId, conversationId, supabase),
}));

afterEach(() => {
  mockGetActiveRequest.mockClear();
  mockGetActiveRequest.mockReset();
  mockGetActiveRequest.mockImplementation(async () => null);
});

describe("chatbotService — not a Server Action, never a direct table write", () => {
  it("[no \"use server\" pragma] never exposable as a Server Action reachable from the browser", () => {
    expect(source).not.toMatch(/^"use server";/m);
  });

  it("[RPC only] no .from(...).insert(...)/.update(...) anywhere in this file", () => {
    expect(source).not.toMatch(/\.from\(/);
  });
});

describe("createPartnerRequestForChatbot", () => {
  it("[calls create_partner_request with the exact params, snake_case p_ prefix]", async () => {
    const { createPartnerRequestForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: "req-1", error: null });

    const id = await createPartnerRequestForChatbot(
      {
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
      },
      supabase as never
    );

    expect(supabase.rpc).toHaveBeenCalledWith("create_partner_request", {
      p_hotel_id: "hotel-a",
      p_partner_id: "partner-1",
      p_conversation_id: "conv-1",
      p_guest_name: "Alice",
      p_guest_phone_e164: "+33612345678",
      p_request_category: "restaurant",
      p_requested_date: "2026-09-01",
      p_requested_time: "20:00",
      p_party_size: 2,
      p_details: "Table calme",
    });
    expect(id).toBe("req-1");
  });

  it("[RPC error] throws — the caller (partnerRequestFlow.ts) is responsible for catching, this function never swallows a failure silently", async () => {
    const { createPartnerRequestForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: null, error: { message: "constraint violation" } });

    await expect(
      createPartnerRequestForChatbot(
        {
          hotelId: "hotel-a",
          partnerId: "partner-1",
          conversationId: "conv-1",
          guestName: null,
          guestPhoneE164: null,
          requestCategory: "restaurant",
          requestedDate: null,
          requestedTime: null,
          partySize: null,
          details: null,
        },
        supabase as never
      )
    ).rejects.toThrow("constraint violation");
  });

  function validParams() {
    return {
      hotelId: "hotel-a",
      partnerId: "partner-1",
      conversationId: "conv-1",
      guestName: "Alice",
      guestPhoneE164: "+33612345678",
      requestCategory: "restaurant",
      requestedDate: "2026-09-01",
      requestedTime: "20:00",
      partySize: 2,
      details: null,
    };
  }

  it("[23505 — simulated concurrency] a unique-violation on the active-request index re-reads the projection and reuses the request another concurrent call already created, instead of surfacing a technical error", async () => {
    const { createPartnerRequestForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } });
    mockGetActiveRequest.mockResolvedValueOnce({ id: "req-existing", status: "draft" });

    const id = await createPartnerRequestForChatbot(validParams(), supabase as never);

    expect(id).toBe("req-existing");
    expect(mockGetActiveRequest).toHaveBeenCalledWith("hotel-a", "conv-1", supabase);
  });

  it("[23505] never a second create_partner_request call — the RPC itself is called exactly once", async () => {
    const { createPartnerRequestForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } });
    mockGetActiveRequest.mockResolvedValueOnce({ id: "req-existing", status: "draft" });

    await createPartnerRequestForChatbot(validParams(), supabase as never);

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
  });

  it("[23505 but no active request found on re-read] not assumed to be this guarantee — the original error is never masked", async () => {
    const { createPartnerRequestForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: null, error: { message: "duplicate key value violates unique constraint", code: "23505" } });
    mockGetActiveRequest.mockResolvedValueOnce(null);

    await expect(createPartnerRequestForChatbot(validParams(), supabase as never)).rejects.toThrow(
      "duplicate key value violates unique constraint"
    );
  });

  it("[other error codes] never trigger the re-read/reuse path — stays a genuine error", async () => {
    const { createPartnerRequestForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: null, error: { message: "permission denied", code: "42501" } });

    await expect(createPartnerRequestForChatbot(validParams(), supabase as never)).rejects.toThrow("permission denied");
    expect(mockGetActiveRequest).not.toHaveBeenCalled();
  });
});

describe("applyPartnerRequestCommandForChatbot", () => {
  it("[calls apply_partner_request_command] with the exact params", async () => {
    const { applyPartnerRequestCommandForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: null, error: null });

    await applyPartnerRequestCommandForChatbot("req-1", "hotel-a", "guest_confirm", supabase as never);

    expect(supabase.rpc).toHaveBeenCalledWith("apply_partner_request_command", {
      p_partner_request_id: "req-1",
      p_hotel_id: "hotel-a",
      p_command: "guest_confirm",
      p_message: null,
      p_metadata: null,
    });
  });

  it("[structurally cannot call a delivery command] the TypeScript type of `command` excludes partner_delivery_succeeded/partner_delivery_failed — verified at the source level since a type-only guarantee can't be asserted at runtime", () => {
    const typeLine = source.match(/type ChatbotPartnerRequestCommand = [^;]+;/)?.[0];
    expect(typeLine).toBeTruthy();
    expect(typeLine).toMatch(/"request_guest_confirmation" \| "guest_confirm"/);
    expect(typeLine).not.toMatch(/partner_delivery_succeeded/);
    expect(typeLine).not.toMatch(/partner_delivery_failed/);
  });

  it("[RPC error] throws", async () => {
    const { applyPartnerRequestCommandForChatbot } = await import("./chatbotService");
    const supabase = fakeSupabase({ data: null, error: { message: "command not allowed from status draft" } });

    await expect(applyPartnerRequestCommandForChatbot("req-1", "hotel-a", "guest_confirm", supabase as never)).rejects.toThrow(
      "command not allowed from status draft"
    );
  });
});
