import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createChatHandler, type ChatRouteDeps } from "./route";
import { hashSessionToken } from "@/features/widget/sessionToken";
import type { PublicWidgetContext } from "@/features/widget/publicHotel";
import type { AnswerQuestionResult } from "@/features/rag/types";

/**
 * Real invocation tests — construct a real Request, call the real exported
 * handler (via createChatHandler with controllable fake dependencies), and
 * assert on the real Response. This is deliberately NOT a source-text
 * search: every test below exercises the actual route logic end to end,
 * including body reading, Zod validation, rate-limit gating, session-token
 * verification, and error handling. The dependency-injection factory
 * (ChatRouteDeps) exists specifically to make this possible without a live
 * Supabase/OpenAI — see the file's own doc comment.
 */

const VALID_TOKEN = "a".repeat(64);
const VALID_TOKEN_HASH = hashSessionToken(VALID_TOKEN);
const OTHER_TOKEN_HASH = hashSessionToken("b".repeat(64));

function makeWidgetContext(): PublicWidgetContext {
  return {
    hotelId: "hotel-1",
    hotel: {
      id: "hotel-1",
      name: "Le 1837",
      slug: "le-1837",
      widget_key: "ps_live_test",
      website: null,
      logo_url: null,
      address: null,
      postal_code: null,
      city: null,
      country: null,
      phone: null,
      email: null,
      primary_color: "#1A1D1A",
      secondary_color: "#8A6A3E",
      languages: ["fr"],
      default_language: "fr",
      booking_url: "https://booking.example.com",
      spa_booking_url: null,
      booking_action_mode: "url",
      host_booking_trigger: null,
      assistant_name: "Camille",
      assistant_enabled: true,
      photo_management: "client",
      status: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    widgetDisplay: { welcomeMessage: "Bonjour !", position: "bottom-right", icon: "chat" },
  };
}

function makeAnswerResult(overrides: Partial<AnswerQuestionResult> = {}): AnswerQuestionResult {
  return {
    reply: "Voici la réponse.",
    sources: [],
    answerStatus: "answered",
    roomRecommendation: null,
    action: null,
    partnerRecommendations: [],
    partnerRequestPhonePrompt: null,
    ...overrides,
  };
}

/** Fake Supabase client covering exactly the query shapes route.ts uses — conversations (select/insert) and messages (count select). */
function fakeSupabase(options: {
  conversationLookup?: { data: { id: string; session_id: string } | null; error: { message: string } | null };
  messageCount?: { count: number | null; error: { message: string } | null };
  insertConversation?: { data: { id: string } | null; error: { message: string } | null };
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === "conversations") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq: () => ({
                    maybeSingle: async () => options.conversationLookup ?? { data: null, error: null },
                  }),
                };
              },
            };
          },
          insert() {
            return {
              select: () => ({
                single: async () => options.insertConversation ?? { data: { id: "new-conversation-id" }, error: null },
              }),
            };
          },
        };
      }
      if (table === "messages") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq: async () => options.messageCount ?? { count: 0, error: null },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table in fake: ${table}`);
    },
  } as unknown as SupabaseClient;
}

function makeDeps(overrides: Partial<ChatRouteDeps> = {}): ChatRouteDeps {
  return {
    createSupabaseClient: () => fakeSupabase({}),
    resolveWidgetContext: vi.fn(async () => makeWidgetContext()),
    checkGlobalRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    checkSessionRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    answerQuestion: vi.fn(async () => makeAnswerResult()),
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://widget.test/api/widget/ps_live_test/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ widgetKey: "ps_live_test" }) } as unknown as Parameters<ReturnType<typeof createChatHandler>>[1];

describe("POST /api/widget/[widgetKey]/chat — widget resolution", () => {
  it("[unknown widget] returns 404 and never calls answerQuestion", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => null) });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(404);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[resolver throws] fails closed with 503, never 404 — a service error is not 'widget not found'", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => Promise.reject(new Error("connection reset"))) });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).not.toMatch(/connection reset/); // no internal detail leaked
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[client creation throws] fails closed with 503", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
      },
    });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("POST /api/widget/[widgetKey]/chat — rate limiting (fail closed)", () => {
  it("[global denied] returns 429 with Retry-After, never calls answerQuestion", async () => {
    const deps = makeDeps({ checkGlobalRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 17 })) });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[global RPC throws] fails closed with 503, never calls OpenAI/answerQuestion", async () => {
    const deps = makeDeps({ checkGlobalRateLimit: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(503);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[session denied] returns 429, never calls answerQuestion", async () => {
    const deps = makeDeps({ checkSessionRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 5 })) });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(429);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[session RPC throws] fails closed with 503", async () => {
    const deps = makeDeps({ checkSessionRateLimit: vi.fn(async () => Promise.reject(new Error("timeout"))) });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(503);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[order] global rate limit is checked before the body is ever read", async () => {
    const deps = makeDeps({ checkGlobalRateLimit: vi.fn(async () => ({ allowed: false, retryAfterSeconds: 1 })) });
    const handler = createChatHandler(deps);
    // A body that would fail Zod validation if it were ever parsed — proves the 429 short-circuits before that.
    const response = await handler(makeRequest("not even json"), context);
    expect(response.status).toBe(429);
  });
});

describe("POST /api/widget/[widgetKey]/chat — body validation", () => {
  it("[oversized body] a body far beyond the transport cap is rejected with 413 BEFORE JSON.parse — a huge non-JSON payload never causes a parse error instead", async () => {
    const handler = createChatHandler(makeDeps());
    const hugeBody = "x".repeat(64 * 1024); // 64 KiB, well past the 32 KiB cap
    const response = await handler(makeRequest(hugeBody), context);
    expect(response.status).toBe(413);
  });

  it("[malformed JSON] returns 400", async () => {
    const handler = createChatHandler(makeDeps());
    const response = await handler(makeRequest("{not valid json"), context);
    expect(response.status).toBe(400);
  });

  it("[message too long] a message beyond the business limit is rejected with 400", async () => {
    const handler = createChatHandler(makeDeps());
    const response = await handler(makeRequest({ conversationId: null, message: "a".repeat(2001), sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(400);
  });

  it("[missing sessionToken] returns 400", async () => {
    const handler = createChatHandler(makeDeps());
    const response = await handler(makeRequest({ conversationId: null, message: "hello" }), context);
    expect(response.status).toBe(400);
  });

  it("[malformed sessionToken] a non-hex or wrong-length token is rejected with 400", async () => {
    const handler = createChatHandler(makeDeps());
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: "not-a-real-token" }), context);
    expect(response.status).toBe(400);
  });

  it("[.strict() rejects extra fields] an attempted hotelId override in the body causes the WHOLE request to be rejected — not silently dropped", async () => {
    const deps = makeDeps();
    const handler = createChatHandler(deps);
    const response = await handler(
      makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN, hotelId: "some-other-hotel" }),
      context
    );
    expect(response.status).toBe(400);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[normal body] a well-formed request is accepted", async () => {
    const handler = createChatHandler(makeDeps());
    const response = await handler(makeRequest({ conversationId: null, message: "Bonjour", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(200);
  });
});

describe("POST /api/widget/[widgetKey]/chat — conversation possession (session token)", () => {
  it("[right conversation, right token] accepted — proceeds to answerQuestion with the resolved hotelId and conversationId", async () => {
    const supabase = fakeSupabase({ conversationLookup: { data: { id: "conv-1", session_id: VALID_TOKEN_HASH }, error: null } });
    const deps = makeDeps({ createSupabaseClient: () => supabase });
    const handler = createChatHandler(deps);

    const response = await handler(makeRequest({ conversationId: "e64afb80-6dc7-4e4b-b00e-484dfd557794", message: "hello", sessionToken: VALID_TOKEN }), context);

    expect(response.status).toBe(200);
    expect(deps.answerQuestion).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "hotel-1", conversationId: "conv-1", message: "hello" }));
  });

  it("[right conversation, WRONG token] rejected with 404 — conversationId alone is never proof of possession", async () => {
    const supabase = fakeSupabase({ conversationLookup: { data: { id: "conv-1", session_id: OTHER_TOKEN_HASH }, error: null } });
    const deps = makeDeps({ createSupabaseClient: () => supabase });
    const handler = createChatHandler(deps);

    const response = await handler(makeRequest({ conversationId: "e64afb80-6dc7-4e4b-b00e-484dfd557794", message: "hello", sessionToken: VALID_TOKEN }), context);

    expect(response.status).toBe(404);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[conversation belongs to a different hotel] the query itself is scoped by hotel_id, so a foreign conversation simply isn't found — rejected with the SAME uniform 404 as a wrong token", async () => {
    // The fake's conversationLookup simulates the query's own .eq("hotel_id", hotelId) filter never matching a foreign-hotel row: no data returned.
    const supabase = fakeSupabase({ conversationLookup: { data: null, error: null } });
    const deps = makeDeps({ createSupabaseClient: () => supabase });
    const handler = createChatHandler(deps);

    const response = await handler(makeRequest({ conversationId: "e64afb80-6dc7-4e4b-b00e-484dfd557794", message: "hello", sessionToken: VALID_TOKEN }), context);

    expect(response.status).toBe(404);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[conversation lookup errors] fails closed with 500, never treated as a valid conversation", async () => {
    const supabase = fakeSupabase({ conversationLookup: { data: null, error: { message: "connection reset" } } });
    const deps = makeDeps({ createSupabaseClient: () => supabase });
    const handler = createChatHandler(deps);

    const response = await handler(makeRequest({ conversationId: "e64afb80-6dc7-4e4b-b00e-484dfd557794", message: "hello", sessionToken: VALID_TOKEN }), context);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toMatch(/connection reset/);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[conversation at message cap] rejected with 400 before answerQuestion is called", async () => {
    const supabase = fakeSupabase({
      conversationLookup: { data: { id: "conv-1", session_id: VALID_TOKEN_HASH }, error: null },
      messageCount: { count: 200, error: null },
    });
    const deps = makeDeps({ createSupabaseClient: () => supabase });
    const handler = createChatHandler(deps);

    const response = await handler(makeRequest({ conversationId: "e64afb80-6dc7-4e4b-b00e-484dfd557794", message: "hello", sessionToken: VALID_TOKEN }), context);

    expect(response.status).toBe(400);
    expect(deps.answerQuestion).not.toHaveBeenCalled();
  });

  it("[new conversation] session_id is stored as hash(sessionToken), never the raw token", async () => {
    const insertSpy = vi.fn(async (row: Record<string, unknown>) => {
      expect(row.session_id).toBe(VALID_TOKEN_HASH);
      expect(row.session_id).not.toBe(VALID_TOKEN);
      return { data: { id: "brand-new-conversation" }, error: null };
    });
    const supabase = {
      from(table: string) {
        if (table === "conversations") {
          return { insert: (row: Record<string, unknown>) => ({ select: () => ({ single: () => insertSpy(row) }) }) };
        }
        throw new Error(`unexpected table: ${table}`);
      },
    } as unknown as SupabaseClient;
    const deps = makeDeps({ createSupabaseClient: () => supabase });
    const handler = createChatHandler(deps);

    await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);

    expect(insertSpy).toHaveBeenCalled();
  });
});

describe("POST /api/widget/[widgetKey]/chat — answerQuestion outcome", () => {
  it("[success] returns exactly conversationId/reply/answerStatus/roomRecommendation/action/partnerRecommendations/partnerRequestPhonePrompt — never sources", async () => {
    const deps = makeDeps({
      answerQuestion: vi.fn(async () =>
        makeAnswerResult({ action: { type: "booking", label: "Réserver", url: "https://booking.example.com" } })
      ),
    });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(
      ["action", "answerStatus", "conversationId", "partnerRecommendations", "partnerRequestPhonePrompt", "reply", "roomRecommendation"].sort()
    );
    expect(body.action).toEqual({ type: "booking", label: "Réserver", url: "https://booking.example.com" });
  });

  it("[partnerRequestPhonePrompt passthrough] present when answerQuestion signals it, never inferred from reply text", async () => {
    const deps = makeDeps({
      answerQuestion: vi.fn(async () =>
        makeAnswerResult({
          partnerRequestPhonePrompt: {
            partnerName: "Le Bistrot",
            pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
          },
        })
      ),
    });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    const body = await response.json();
    expect(body.partnerRequestPhonePrompt).toEqual({
      partnerName: "Le Bistrot",
      pendingRequest: { partnerId: "partner-1", requestedDate: null, requestedTime: null, partySize: null, details: null, guestName: null },
    });
  });

  it("[answerQuestion throws] returns 500 with a generic message, no internal detail leaked", async () => {
    const deps = makeDeps({ answerQuestion: vi.fn(async () => Promise.reject(new Error("OpenAI API key invalid: sk-secret-xyz"))) });
    const handler = createChatHandler(deps);
    const response = await handler(makeRequest({ conversationId: null, message: "hello", sessionToken: VALID_TOKEN }), context);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toMatch(/sk-secret-xyz/);
    expect(body.error).not.toMatch(/OpenAI/);
  });
});
