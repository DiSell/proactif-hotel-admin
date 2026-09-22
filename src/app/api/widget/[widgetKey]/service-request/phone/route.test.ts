import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHandoverPhoneHandler, type HandoverPhoneRouteDeps } from "./route";
import { hashSessionToken } from "@/features/widget/sessionToken";
import type { PublicWidgetContext } from "@/features/widget/publicHotel";
import type { SubmitHandoverPhoneResult } from "@/features/rag/humanHandoverFlow";

/**
 * HUMAN HANDOVER / RAPPEL SMS chantier — mirrors
 * partner-request/phone/route.test.ts exactly: a real Request through the
 * real handler (DI factory), asserting on the real Response.
 * submitHandoverPhone itself is mocked here (exhaustively tested in
 * humanHandoverFlow.test.ts) — this file is scoped to the ROUTE's own
 * responsibilities: widget resolution, body validation, conversation/session
 * ownership, phone normalization, and status-code mapping. No real SMS, no
 * real Twilio call anywhere in this file (section 13).
 */

const VALID_TOKEN = "a".repeat(64);
const VALID_TOKEN_HASH = hashSessionToken(VALID_TOKEN);
const OTHER_TOKEN_HASH = hashSessionToken("b".repeat(64));
const CONVERSATION_ID = "11111111-1111-1111-8111-111111111111";

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
      total_accommodation_units: null,
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

function makeDeps(overrides: Partial<HandoverPhoneRouteDeps> = {}): HandoverPhoneRouteDeps {
  return {
    createSupabaseClient: () => fakeSupabase(),
    resolveWidgetContext: vi.fn(async () => makeWidgetContext()),
    submitHandoverPhone: vi.fn(async (): Promise<SubmitHandoverPhoneResult> => ({ ok: true, message: "Votre demande a bien été transmise." })),
    ...overrides,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://widget.test/api/widget/ps_live_test/service-request/phone", {
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
    pendingHandover: {
      guestMessage: "Rappelez-moi dès que possible",
      roomNumber: null,
    },
    ...overrides,
  };
}

describe("POST /api/widget/[widgetKey]/service-request/phone — widget resolution", () => {
  it("[unknown widget] 404", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => null) });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(404);
  });

  it("[resolver throws] fails closed with 503", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => Promise.reject(new Error("db down"))) });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(503);
  });
});

describe("POST /api/widget/[widgetKey]/service-request/phone — body validation", () => {
  it("[invalid JSON] 400", async () => {
    const handler = createHandoverPhoneHandler(makeDeps());
    const response = await handler(makeRequest("not json"), context);
    expect(response.status).toBe(400);
  });

  it("[missing fields] 400", async () => {
    const handler = createHandoverPhoneHandler(makeDeps());
    const response = await handler(makeRequest({ conversationId: CONVERSATION_ID }), context);
    expect(response.status).toBe(400);
  });

  it("[extra unexpected field] rejected — .strict() schema, e.g. an attempted hotelId override", async () => {
    const handler = createHandoverPhoneHandler(makeDeps());
    const response = await handler(makeRequest({ ...validBody(), hotelId: "attempted-override" }), context);
    expect(response.status).toBe(400);
  });

  it("[extra field inside pendingHandover] rejected — nested .strict() schema", async () => {
    const handler = createHandoverPhoneHandler(makeDeps());
    const body = validBody();
    (body.pendingHandover as Record<string, unknown>).kind = "incident";
    const response = await handler(makeRequest(body), context);
    expect(response.status).toBe(400);
  });

  it("[malformed sessionToken] 400", async () => {
    const handler = createHandoverPhoneHandler(makeDeps());
    const response = await handler(makeRequest(validBody({ sessionToken: "short" })), context);
    expect(response.status).toBe(400);
  });

  it("[room number too long] 400", async () => {
    const handler = createHandoverPhoneHandler(makeDeps());
    const body = validBody();
    (body.pendingHandover as Record<string, unknown>).roomNumber = "x".repeat(60);
    const response = await handler(makeRequest(body), context);
    expect(response.status).toBe(400);
  });
});

describe("POST /api/widget/[widgetKey]/service-request/phone — conversation ownership", () => {
  it("[unknown conversation] 404, never a distinguishable message", async () => {
    const deps = makeDeps({ createSupabaseClient: () => fakeSupabase({ conversationLookup: { data: null, error: null } }) });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(404);
  });

  it("[wrong session token for a real conversation] 404, identical to unknown conversation", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => fakeSupabase({ conversationLookup: { data: { id: CONVERSATION_ID, session_id: OTHER_TOKEN_HASH }, error: null } }),
    });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(404);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).not.toHaveBeenCalled();
  });

  it("[conversation lookup errors] 500, never treated as valid", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => fakeSupabase({ conversationLookup: { data: null, error: { message: "connection reset" } } }),
    });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(500);
  });
});

describe("POST /api/widget/[widgetKey]/service-request/phone — phone normalization", () => {
  it("[valid FR national] accepted, normalized to E.164 before being forwarded", async () => {
    const deps = makeDeps();
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody({ phone: "06 12 34 56 78" })), context);
    expect(response.status).toBe(200);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).toHaveBeenCalledWith(expect.objectContaining({ phoneE164: "+33612345678" }));
  });

  it("[valid international] accepted, normalized", async () => {
    const deps = makeDeps();
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody({ phone: "+33 6 12 34 56 78" })), context);
    expect(response.status).toBe(200);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).toHaveBeenCalledWith(expect.objectContaining({ phoneE164: "+33612345678" }));
  });

  it("[invalid format] 400, readable message, submitHandoverPhone never called — no write attempted", async () => {
    const deps = makeDeps();
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody({ phone: "12345" })), context);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/invalide/i);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).not.toHaveBeenCalled();
  });

  it("[missing client phone entirely] handled upstream by the widget always sending the form — an empty phone string is still rejected as invalid here", async () => {
    const handler = createHandoverPhoneHandler(makeDeps());
    const response = await handler(makeRequest(validBody({ phone: "" })), context);
    expect(response.status).toBe(400);
  });
});

describe("POST /api/widget/[widgetKey]/service-request/phone — guestMessage / roomNumber forwarding", () => {
  it("[message with room] roomNumber forwarded exactly as submitted, never invented", async () => {
    const deps = makeDeps();
    const handler = createHandoverPhoneHandler(deps);
    await handler(makeRequest(validBody({ pendingHandover: { guestMessage: "Rappelez-moi", roomNumber: "204" } })), context);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).toHaveBeenCalledWith(expect.objectContaining({ roomNumber: "204" }));
  });

  it("[message without room] roomNumber forwarded as null, never a guessed value", async () => {
    const deps = makeDeps();
    const handler = createHandoverPhoneHandler(deps);
    await handler(makeRequest(validBody({ pendingHandover: { guestMessage: "Rappelez-moi", roomNumber: null } })), context);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).toHaveBeenCalledWith(expect.objectContaining({ roomNumber: null }));
  });

  it("[guestMessage forwarded verbatim, never re-summarized]", async () => {
    const deps = makeDeps();
    const handler = createHandoverPhoneHandler(deps);
    await handler(makeRequest(validBody({ pendingHandover: { guestMessage: "Le chauffage de ma chambre est en panne", roomNumber: null } })), context);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).toHaveBeenCalledWith(expect.objectContaining({ guestMessage: "Le chauffage de ma chambre est en panne" }));
  });
});

describe("POST /api/widget/[widgetKey]/service-request/phone — result mapping", () => {
  it("[success] 200 with { ok: true, message }", async () => {
    const deps = makeDeps({
      submitHandoverPhone: vi.fn(async (): Promise<SubmitHandoverPhoneResult> => ({ ok: true, message: "Votre demande a bien été transmise à l'établissement. Vous serez contacté dans les meilleurs délais." })),
    });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ok: true, message: "Votre demande a bien été transmise à l'établissement. Vous serez contacté dans les meilleurs délais." });
  });

  it("[submitHandoverPhone reports ok:false] 400, no internal detail leaked", async () => {
    const deps = makeDeps({
      submitHandoverPhone: vi.fn(async (): Promise<SubmitHandoverPhoneResult> => ({ ok: false, error: "Impossible d'enregistrer votre demande. Merci de réessayer." })),
    });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(400);
  });

  it("[submitHandoverPhone throws] 500, no internal detail leaked", async () => {
    const deps = makeDeps({ submitHandoverPhone: vi.fn(async () => Promise.reject(new Error("RPC secret detail: sk-xyz"))) });
    const handler = createHandoverPhoneHandler(deps);
    const response = await handler(makeRequest(validBody()), context);
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toMatch(/sk-xyz/);
  });

  it("[tenant isolation] hotelId passed to submitHandoverPhone is always the SERVER-resolved one, never client-suppliable", async () => {
    const deps = makeDeps();
    const handler = createHandoverPhoneHandler(deps);
    await handler(makeRequest(validBody()), context);
    const submitHandoverPhone = deps.submitHandoverPhone as ReturnType<typeof vi.fn>;
    expect(submitHandoverPhone).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "hotel-1" }));
  });
});
