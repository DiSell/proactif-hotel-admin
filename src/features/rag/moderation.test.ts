import { describe, expect, it, vi, beforeEach } from "vitest";

const mockSendEmail = vi.fn<(...args: unknown[]) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
vi.mock("@/lib/email/sendEmail", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockTemplate = vi.fn<(...args: unknown[]) => { subject: string; html: string; text: string }>(() => ({ subject: "s", html: "h", text: "t" }));
vi.mock("@/lib/email/templates/conversationFlagged", () => ({
  conversationFlaggedTemplate: (...args: unknown[]) => mockTemplate(...args),
}));

vi.mock("@/lib/http/currentOrigin", () => ({
  currentOrigin: async () => "https://app.example.com",
}));

beforeEach(() => {
  mockSendEmail.mockClear();
  mockTemplate.mockClear();
});

/**
 * Real-invocation tests with a hand-built fake Supabase client — same
 * convention as features/spa/booking.test.ts's notifySpaBookingOwner tests.
 */
function fakeSupabase(options: {
  rpcResult?: { data: unknown; error: { message: string } | null };
  hotel?: { name: string; email: string | null } | null;
  handoffEmail?: string | null;
}) {
  const rpc = vi.fn(async () => options.rpcResult ?? { data: true, error: null });
  const from = vi.fn((table: string) => {
    if (table === "hotels") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: options.hotel ?? { name: "Le 1837", email: "hotel@example.com" } }) }) }) };
    }
    if (table === "chatbot_settings") {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { handoff_email: options.handoffEmail ?? null } }) }) }) };
    }
    throw new Error(`unexpected table in fake: ${table}`);
  });
  return { rpc, from };
}

describe("flagConversationForModeration", () => {
  it("[first flag] rpc returns true -> sends exactly one notification email", async () => {
    const { flagConversationForModeration } = await import("./moderation");
    const supabase = fakeSupabase({ rpcResult: { data: true, error: null } });

    await flagConversationForModeration("hotel-1", "conv-1", "propos insultants", supabase as never);

    expect(supabase.rpc).toHaveBeenCalledWith("flag_conversation", { p_hotel_id: "hotel-1", p_conversation_id: "conv-1", p_reason: "propos insultants" });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ hotelName: "Le 1837", reason: "propos insultants", conversationUrl: "https://app.example.com/client/conversations/conv-1" })
    );
  });

  it("[already flagged] rpc returns false -> never sends a second email (idempotent, at most one notification per conversation)", async () => {
    const { flagConversationForModeration } = await import("./moderation");
    const supabase = fakeSupabase({ rpcResult: { data: false, error: null } });

    await flagConversationForModeration("hotel-1", "conv-1", "propos insultants", supabase as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("[rpc error] never throws, never sends an email", async () => {
    const { flagConversationForModeration } = await import("./moderation");
    const supabase = fakeSupabase({ rpcResult: { data: null, error: { message: "db down" } } });

    await expect(flagConversationForModeration("hotel-1", "conv-1", "reason", supabase as never)).resolves.toBeUndefined();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("[no contact email configured] first flag still succeeds (RPC call happened), but no email is sent", async () => {
    const { flagConversationForModeration } = await import("./moderation");
    const supabase = fakeSupabase({ rpcResult: { data: true, error: null }, hotel: { name: "Le 1837", email: null }, handoffEmail: null });

    await flagConversationForModeration("hotel-1", "conv-1", "reason", supabase as never);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("[handoff_email preferred over hotels.email]", async () => {
    const { flagConversationForModeration } = await import("./moderation");
    const supabase = fakeSupabase({ rpcResult: { data: true, error: null }, hotel: { name: "Le 1837", email: "fallback@example.com" }, handoffEmail: "handoff@example.com" });

    await flagConversationForModeration("hotel-1", "conv-1", "reason", supabase as never);

    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "handoff@example.com" }));
  });

  it("[email send throws] never propagates — best-effort all the way through", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error("provider outage"));
    const { flagConversationForModeration } = await import("./moderation");
    const supabase = fakeSupabase({ rpcResult: { data: true, error: null } });

    await expect(flagConversationForModeration("hotel-1", "conv-1", "reason", supabase as never)).resolves.toBeUndefined();
  });
});
