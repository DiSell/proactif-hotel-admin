import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createPhoneHandler, type PhoneRouteDeps } from "./route";
import { hashSessionToken } from "@/features/widget/sessionToken";
import type { PublicWidgetContext } from "@/features/widget/publicHotel";
import type { SubmitStructuredGuestPhoneResult } from "@/features/rag/partnerRequestFlow";

/**
 * Real invocation tests — same convention as
 * /api/widget/[widgetKey]/chat/route.test.ts: a real Request through the
 * real handler (via createPhoneHandler's DI factory), asserting on the
 * real Response. submitStructuredGuestPhone itself is mocked here (its own
 * business logic is exhaustively tested in partnerRequestFlow.test.ts) —
 * this file is scoped to the ROUTE's own responsibilities: widget
 * resolution, body validation, conversation/session ownership, phone
 * normalization, and status-code mapping.
 */

const VALID_TOKEN = "a".repeat(64);
const VALID_TOKEN_HASH = hashSessionToken(VALID_TOKEN);
const OTHER_TOKEN_HASH = hashSessionToken("b".repeat(64));
const CONVERSATION_ID = "11111111-1111-1111-8111-111111111111";
const PARTNER_ID = "22222222-2222-2222-8222-222222222222";

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
      booking_url: null,
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

function fakeSupabase(options: { conversationLookup?: { data: unknown; error: { message: string } | null } } = {}): SupabaseClient {
  return {
    from(table: string) {
      if (table === "conversations") {
        return {
          select() {
            return {
              eq() {
                return {
                  eq: () => ({
                    maybeSingle: async () => options.conversationLookup ?? { data: { id: CONVERSATION_ID, session_id: VALID_TOKEN_HASH }, error: null },
                  }),
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

function makeDeps(overrides: Partial<PhoneRouteDeps> = {}): PhoneRouteDeps {
  return {
    createSupabaseClient: () => fakeSupabase(),
    resolveWidgetContext: vi.fn(async () => makeWidgetContext()),
    submitStructuredGuestPhone: vi.fn(async (): Promise<SubmitStructuredGuestPhoneResult> => ({ ok: true, message: "Récapitulatif." })),
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://widget.test/api/widget/ps_live_test/partner-request/phone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ widgetKey: "ps_live_test" }) };

function validBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    conversationId: CONVERSATION_ID,
    sessionToken: VALID_TOKEN,
    phone: "06 12 34 56 78",
    pendingRequest: {
      partnerId: PARTNER_ID,
      requestedDate: "2026-09-01",
      requestedTime: "20:00",
      partySize: 2,
      details: "Table calme",
      guestName: "Alice",
    },
    ...overrides,
  };
}

describe("POST /api/widget/[widgetKey]/partner-request/phone — widget resolution", () => {
  it("[unknown widget] 404", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => null) });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(404);
  });

  it("[resolver throws] fails closed with 503", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(503);
  });
});

describe("POST /api/widget/[widgetKey]/partner-request/phone — body validation", () => {
  it("[invalid JSON] 400", async () => {
    const handler = createPhoneHandler(makeDeps());
    const response = await handler(makeRequest("not json"), context);
    expect(response.status).toBe(400);
  });

  it("[missing fields] 400", async () => {
    const handler = createPhoneHandler(makeDeps());
    const response = await handler(makeRequest({ conversationId: CONVERSATION_ID }), context);
    expect(response.status).toBe(400);
  });

  it("[extra unexpected field] rejected — .strict() schema", async () => {
    const handler = createPhoneHandler(makeDeps());
    const response = await handler(makeRequest({ ...validBody(), hotelId: "attempted-override" }), context);
    expect(response.status).toBe(400);
  });

  it("[extra field inside pendingRequest] rejected — nested .strict() schema", async () => {
    const handler = createPhoneHandler(makeDeps());
    const body = validBody();
    (body.pendingRequest as Record<string, unknown>).status = "accepted";
    const response = await handler(makeRequest(body), context);
    expect(response.status).toBe(400);
  });

  it("[malformed sessionToken] 400", async () => {
    const handler = createPhoneHandler(makeDeps());
    const response = await handler(makeRequest(validBody({ sessionToken: "short" })), context);
    expect(response.status).toBe(400);
  });
});

describe("POST /api/widget/[widgetKey]/partner-request/phone — conversation ownership", () => {
  it("[unknown conversation] 404, never a distinguishable message", async () => {
    const deps = makeDeps({ createSupabaseClient: () => fakeSupabase({ conversationLookup: { data: null, error: null } }) });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(404);
  });

  it("[wrong session token for a real conversation] 404, identical to unknown conversation", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => fakeSupabase({ conversationLookup: { data: { id: CONVERSATION_ID, session_id: OTHER_TOKEN_HASH }, error: null } }),
    });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(404);
    const submitStructuredGuestPhone = deps.submitStructuredGuestPhone as ReturnType<typeof vi.fn>;
    expect(submitStructuredGuestPhone).not.toHaveBeenCalled();
  });

  it("[conversation lookup errors] 500, never treated as valid", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => fakeSupabase({ conversationLookup: { data: null, error: { message: "connection reset" } } }),
    });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(500);
  });
});

describe("POST /api/widget/[widgetKey]/partner-request/phone — phone normalization", () => {
  it("[valid FR national] accepted, normalized to E.164 before being forwarded", async () => {
    const deps = makeDeps();
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody({ phone: "06 12 34 56 78" })), context);
    expect(response.status).toBe(200);
    const submitStructuredGuestPhone = deps.submitStructuredGuestPhone as ReturnType<typeof vi.fn>;
    expect(submitStructuredGuestPhone).toHaveBeenCalledWith(expect.objectContaining({ phoneE164: "+33612345678" }));
  });

  it("[valid international] accepted, normalized", async () => {
    const deps = makeDeps();
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody({ phone: "+33 6 12 34 56 78" })), context);
    expect(response.status).toBe(200);
    const submitStructuredGuestPhone = deps.submitStructuredGuestPhone as ReturnType<typeof vi.fn>;
    expect(submitStructuredGuestPhone).toHaveBeenCalledWith(expect.objectContaining({ phoneE164: "+33612345678" }));
  });

  it("[invalid format] 400, readable message, submitStructuredGuestPhone never called — no write attempted", async () => {
    const deps = makeDeps();
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody({ phone: "12345" })), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalide/i);
    const submitStructuredGuestPhone = deps.submitStructuredGuestPhone as ReturnType<typeof vi.fn>;
    expect(submitStructuredGuestPhone).not.toHaveBeenCalled();
  });

  it("[ambiguous format] never guesses a country code — rejected", async () => {
    const deps = makeDeps();
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody({ phone: "123456789012" })), context);
    expect(response.status).toBe(400);
  });

  it("[raw phone never logged]", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = makeDeps();
    const handler = createPhoneHandler(deps);
    await handler(makeRequest(validBody({ phone: "0699999999" })), context);
    for (const call of errorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/0699999999/);
      expect(JSON.stringify(call)).not.toMatch(/\+33699999999/);
    }
    errorSpy.mockRestore();
  });
});

describe("POST /api/widget/[widgetKey]/partner-request/phone — result mapping", () => {
  it("[success] 200 with { ok: true, message }", async () => {
    const deps = makeDeps({
      submitStructuredGuestPhone: vi.fn(async (): Promise<SubmitStructuredGuestPhoneResult> => ({ ok: true, message: "Voici le récapitulatif." })),
    });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, message: "Voici le récapitulatif." });
  });

  it("[phone_mismatch] 409 — never a silent overwrite", async () => {
    const deps = makeDeps({
      submitStructuredGuestPhone: vi.fn(
        async (): Promise<SubmitStructuredGuestPhoneResult> => ({
          ok: false,
          code: "phone_mismatch",
          error: "Un numéro différent a déjà été enregistré.",
        })
      ),
    });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(409);
  });

  it("[partner_unavailable] 400", async () => {
    const deps = makeDeps({
      submitStructuredGuestPhone: vi.fn(
        async (): Promise<SubmitStructuredGuestPhoneResult> => ({
          ok: false,
          code: "partner_unavailable",
          error: "Ce partenaire n'est plus disponible.",
        })
      ),
    });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(400);
  });

  it("[unsupported_state] 400", async () => {
    const deps = makeDeps({
      submitStructuredGuestPhone: vi.fn(
        async (): Promise<SubmitStructuredGuestPhoneResult> => ({ ok: false, code: "unsupported_state", error: "État non compatible." })
      ),
    });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(400);
  });

  it("[submitStructuredGuestPhone throws] 500, no internal detail leaked", async () => {
    const deps = makeDeps({ submitStructuredGuestPhone: vi.fn(async () => Promise.reject(new Error("RPC secret detail: sk-xyz"))) });
    const handler = createPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toMatch(/sk-xyz/);
  });

  it("[tenant isolation] hotelId passed to submitStructuredGuestPhone is always the SERVER-resolved one, never client-suppliable", async () => {
    const deps = makeDeps();
    const handler = createPhoneHandler(deps);
    await handler(makeRequest(validBody()), context);
    const submitStructuredGuestPhone = deps.submitStructuredGuestPhone as ReturnType<typeof vi.fn>;
    expect(submitStructuredGuestPhone).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "hotel-1" }));
  });
});
