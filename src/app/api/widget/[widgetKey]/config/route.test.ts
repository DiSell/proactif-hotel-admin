import { describe, expect, it, vi } from "vitest";
import { createConfigHandler, type ConfigRouteDeps } from "./route";
import type { PublicWidgetContext } from "@/features/widget/publicHotel";

/**
 * Real invocation tests via createConfigHandler's dependency injection —
 * same reasoning as the chat route's tests: a real Request goes through
 * the real handler, only the Supabase-touching resolver is faked.
 */

function makeWidgetContext(): PublicWidgetContext {
  return {
    hotelId: "hotel-1",
    hotel: {
      id: "hotel-1",
      name: "Le 1837",
      slug: "le-1837",
      widget_key: "ps_live_test",
      website: null,
      logo_url: "https://cdn.example.com/logo.png",
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
    widgetDisplay: { welcomeMessage: "Bonjour !", position: "top-right", icon: "help" },
  };
}

function makeDeps(overrides: Partial<ConfigRouteDeps> = {}): ConfigRouteDeps {
  return {
    createSupabaseClient: () => ({}) as never,
    resolveWidgetContext: vi.fn(async () => makeWidgetContext()),
    ...overrides,
  };
}

const context = { params: Promise.resolve({ widgetKey: "ps_live_test" }) } as unknown as Parameters<ReturnType<typeof createConfigHandler>>[1];

describe("GET /api/widget/[widgetKey]/config", () => {
  it("[found] returns exactly the public-safe fields, 200", async () => {
    const handler = createConfigHandler(makeDeps());
    const response = await handler(new Request("http://widget.test/api/widget/ps_live_test/config"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      hotelName: "Le 1837",
      assistantName: "Camille",
      welcomeMessage: "Bonjour !",
      primaryColor: "#1A1D1A",
      secondaryColor: "#8A6A3E",
      position: "top-right",
      icon: "help",
      logoUrl: "https://cdn.example.com/logo.png",
      bookingActionMode: "url",
      hostBookingTrigger: null,
    });
  });

  it("[host_widget mode] exposes bookingActionMode and the validated trigger — never a URL", async () => {
    const widgetContext = makeWidgetContext();
    widgetContext.hotel.booking_action_mode = "host_widget";
    widgetContext.hotel.host_booking_trigger = { strategy: "click", selector: "#resa-toggle-menu" };
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => widgetContext) });
    const handler = createConfigHandler(deps);
    const response = await handler(new Request("http://widget.test/api/widget/ps_live_test/config"), context);
    const body = await response.json();
    expect(body.bookingActionMode).toBe("host_widget");
    expect(body.hostBookingTrigger).toEqual({ strategy: "click", selector: "#resa-toggle-menu" });
  });

  it("[host_widget mode, malformed trigger] fails safe — hostBookingTrigger is null, never a broken payload", async () => {
    const widgetContext = makeWidgetContext();
    widgetContext.hotel.booking_action_mode = "host_widget";
    widgetContext.hotel.host_booking_trigger = { strategy: "javascript", code: "alert(1)" };
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => widgetContext) });
    const handler = createConfigHandler(deps);
    const response = await handler(new Request("http://widget.test/api/widget/ps_live_test/config"), context);
    const body = await response.json();
    expect(body.bookingActionMode).toBe("host_widget");
    expect(body.hostBookingTrigger).toBeNull();
  });

  it("[not found] returns 404", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => null) });
    const handler = createConfigHandler(deps);
    const response = await handler(new Request("http://widget.test/api/widget/ps_live_unknown/config"), context);
    expect(response.status).toBe(404);
  });

  it("[resolver throws] fails closed with 503, not 404 — a service error is not 'widget not found'", async () => {
    const deps = makeDeps({ resolveWidgetContext: vi.fn(async () => Promise.reject(new Error("connection reset"))) });
    const handler = createConfigHandler(deps);
    const response = await handler(new Request("http://widget.test/api/widget/ps_live_test/config"), context);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).not.toMatch(/connection reset/);
  });

  it("[client creation throws] fails closed with 503, no internal detail leaked", async () => {
    const deps = makeDeps({
      createSupabaseClient: () => {
        throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
      },
    });
    const handler = createConfigHandler(deps);
    const response = await handler(new Request("http://widget.test/api/widget/ps_live_test/config"), context);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
