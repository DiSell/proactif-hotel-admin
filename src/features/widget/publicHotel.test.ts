import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPublicWidgetConfig, publicWidgetConfigSchema, resolvePublicWidgetContext, type PublicWidgetContext } from "./publicHotel";
import type { Hotel, WidgetSettings } from "@/types/database";

function makeHotel(overrides: Partial<Hotel> = {}): Hotel {
  return {
    id: "hotel-1",
    name: "Le 1837",
    slug: "le-1837",
    widget_key: "ps_live_test",
    website: "https://le1837.example.com",
    logo_url: null,
    address: null,
    postal_code: null,
    city: "Saint-Affrique",
    country: "France",
    phone: null,
    email: null,
    primary_color: "#1A1D1A",
    secondary_color: "#8A6A3E",
    languages: ["fr"],
    default_language: "fr",
    booking_url: "https://booking.example.com/le1837",
    spa_booking_url: null,
    booking_action_mode: "url",
    host_booking_trigger: null,
    assistant_name: "Camille",
    assistant_enabled: true,
    photo_management: "client",
    status: "active",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

/**
 * Minimal fake matching only the exact chain resolvePublicWidgetContext
 * actually calls (.from(table).select("*").eq(col, val).maybeSingle()) —
 * enough to unit-test the real gating logic without a live Postgres.
 */
function fakeSupabase(responses: {
  hotels: { data: Hotel | null; error: { message: string } | null };
  widgetSettings?: { data: WidgetSettings | null; error: { message: string } | null };
}): SupabaseClient {
  const widgetSettingsResponse = responses.widgetSettings ?? { data: null, error: null };
  return {
    from(table: string) {
      const response = table === "hotels" ? responses.hotels : widgetSettingsResponse;
      return {
        select() {
          return {
            eq() {
              return { maybeSingle: async () => response };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

function makeWidgetSettings(overrides: Partial<WidgetSettings> = {}): WidgetSettings {
  return {
    id: "ws-1",
    hotel_id: "hotel-1",
    position: "top-left",
    icon: "help",
    welcome_message: "Salut !",
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("resolvePublicWidgetContext", () => {
  it("[valid key] resolves the hotel and widget display settings", async () => {
    const supabase = fakeSupabase({
      hotels: { data: makeHotel(), error: null },
      widgetSettings: { data: makeWidgetSettings(), error: null },
    });
    const result = await resolvePublicWidgetContext("ps_live_test", supabase);
    expect(result).not.toBeNull();
    expect(result?.hotelId).toBe("hotel-1");
    expect(result?.widgetDisplay).toEqual({ welcomeMessage: "Salut !", position: "top-left", icon: "help" });
  });

  it("[unknown key] no matching hotel row -> null (404), not a thrown error", async () => {
    const supabase = fakeSupabase({ hotels: { data: null, error: null } });
    await expect(resolvePublicWidgetContext("ps_live_unknown", supabase)).resolves.toBeNull();
  });

  it("[hotel not published] status !== 'active' -> null", async () => {
    const supabase = fakeSupabase({ hotels: { data: makeHotel({ status: "draft" }), error: null } });
    await expect(resolvePublicWidgetContext("ps_live_test", supabase)).resolves.toBeNull();
  });

  it("[assistant disabled] assistant_enabled === false -> null", async () => {
    const supabase = fakeSupabase({ hotels: { data: makeHotel({ assistant_enabled: false }), error: null } });
    await expect(resolvePublicWidgetContext("ps_live_test", supabase)).resolves.toBeNull();
  });

  it("[widget explicitly deactivated] widget_settings.is_active === false -> null, even though the hotel itself is active", async () => {
    const supabase = fakeSupabase({
      hotels: { data: makeHotel(), error: null },
      widgetSettings: { data: makeWidgetSettings({ is_active: false }), error: null },
    });
    await expect(resolvePublicWidgetContext("ps_live_test", supabase)).resolves.toBeNull();
  });

  it("[no widget_settings row] defaults to active with the documented defaults — never treated as inactive-by-absence", async () => {
    const supabase = fakeSupabase({ hotels: { data: makeHotel(), error: null }, widgetSettings: { data: null, error: null } });
    const result = await resolvePublicWidgetContext("ps_live_test", supabase);
    expect(result).not.toBeNull();
    expect(result?.widgetDisplay).toEqual({ welcomeMessage: "Bonjour ! Comment puis-je vous aider ?", position: "bottom-right", icon: "chat" });
  });

  it("[fail closed] a genuine hotels query error THROWS — never collapsed into a 404", async () => {
    const supabase = fakeSupabase({ hotels: { data: null, error: { message: "connection reset" } } });
    await expect(resolvePublicWidgetContext("ps_live_test", supabase)).rejects.toThrow(/connection reset/);
  });

  it("[fail closed] a genuine widget_settings query error THROWS — never silently falls back to defaults", async () => {
    const supabase = fakeSupabase({
      hotels: { data: makeHotel(), error: null },
      widgetSettings: { data: null, error: { message: "timeout" } },
    });
    await expect(resolvePublicWidgetContext("ps_live_test", supabase)).rejects.toThrow(/timeout/);
  });

  it("[empty widgetKey] returns null without ever querying Supabase", async () => {
    const supabase = fakeSupabase({ hotels: { data: makeHotel(), error: null } });
    await expect(resolvePublicWidgetContext("", supabase)).resolves.toBeNull();
  });
});

function makeContext(overrides: Partial<PublicWidgetContext> = {}): PublicWidgetContext {
  return {
    hotelId: "hotel-1",
    hotel: makeHotel(),
    widgetDisplay: { welcomeMessage: "Bonjour !", position: "bottom-right", icon: "chat" },
    ...overrides,
  };
}

describe("buildPublicWidgetConfig", () => {
  it("returns exactly the public-safe fields — real unit test, no Supabase involved", () => {
    const config = buildPublicWidgetConfig(makeContext());
    expect(config).toEqual({
      hotelName: "Le 1837",
      assistantName: "Camille",
      welcomeMessage: "Bonjour !",
      primaryColor: "#1A1D1A",
      secondaryColor: "#8A6A3E",
      position: "bottom-right",
      icon: "chat",
      logoUrl: null,
      bookingActionMode: "url",
      hostBookingTrigger: null,
    });
  });

  it("[no internal leakage] never includes hotelId/booking_url/widget_key/status", () => {
    const config = buildPublicWidgetConfig(makeContext());
    expect(Object.keys(config).sort()).toEqual(
      [
        "assistantName",
        "bookingActionMode",
        "hostBookingTrigger",
        "hotelName",
        "icon",
        "logoUrl",
        "position",
        "primaryColor",
        "secondaryColor",
        "welcomeMessage",
      ].sort()
    );
    expect("hotelId" in config).toBe(false);
    expect("booking_url" in config).toBe(false);
    expect("widget_key" in config).toBe(false);
    expect("status" in config).toBe(false);
  });

  it("[host_widget mode, valid trigger] exposes bookingActionMode and the validated, closed-shape trigger", () => {
    const config = buildPublicWidgetConfig(
      makeContext({
        hotel: makeHotel({ booking_action_mode: "host_widget", booking_url: null, host_booking_trigger: { strategy: "click", selector: "#resa-toggle-menu" } }),
      })
    );
    expect(config.bookingActionMode).toBe("host_widget");
    expect(config.hostBookingTrigger).toEqual({ strategy: "click", selector: "#resa-toggle-menu" });
  });

  it("[host_widget mode, malformed trigger] fails safe — hostBookingTrigger is null, never a raw/broken JSON blob leaked to the client", () => {
    const config = buildPublicWidgetConfig(
      makeContext({
        hotel: makeHotel({ booking_action_mode: "host_widget", booking_url: null, host_booking_trigger: { strategy: "javascript", code: "alert(1)" } }),
      })
    );
    expect(config.bookingActionMode).toBe("host_widget");
    expect(config.hostBookingTrigger).toBeNull();
  });

  it("[url mode] never exposes a stale host_booking_trigger even if one happens to still be stored", () => {
    const config = buildPublicWidgetConfig(
      makeContext({
        hotel: makeHotel({ booking_action_mode: "url", booking_url: "https://booking.example.com", host_booking_trigger: { strategy: "click", selector: "#old-selector" } }),
      })
    );
    expect(config.bookingActionMode).toBe("url");
    expect(config.hostBookingTrigger).toBeNull();
  });

  it("[multi-tenant isolation] each hotel's own trigger is independent — hotel A's selector never appears for hotel B", () => {
    const configA = buildPublicWidgetConfig(
      makeContext({
        hotelId: "hotel-a",
        hotel: makeHotel({ id: "hotel-a", booking_action_mode: "host_widget", booking_url: null, host_booking_trigger: { strategy: "click", selector: "#a" } }),
      })
    );
    const configB = buildPublicWidgetConfig(
      makeContext({
        hotelId: "hotel-b",
        hotel: makeHotel({ id: "hotel-b", booking_action_mode: "host_widget", booking_url: null, host_booking_trigger: { strategy: "click", selector: "#b" } }),
      })
    );
    expect(configA.hostBookingTrigger).toEqual({ strategy: "click", selector: "#a" });
    expect(configB.hostBookingTrigger).toEqual({ strategy: "click", selector: "#b" });
  });

  it("[.strict() really throws] the schema buildPublicWidgetConfig uses rejects an object with an excess key, at runtime — not silently stripped", () => {
    const valid = buildPublicWidgetConfig(makeContext());
    expect(() => publicWidgetConfigSchema.parse({ ...valid, hotelId: "hotel-1" })).toThrow();
    expect(() => publicWidgetConfigSchema.parse({ ...valid, credential_reference: "leak" })).toThrow();
    expect(() => publicWidgetConfigSchema.parse(valid)).not.toThrow();
  });

  it("falls back to 'Assistant' when assistant_name is null", () => {
    const config = buildPublicWidgetConfig(makeContext({ hotel: makeHotel({ assistant_name: null }) }));
    expect(config.assistantName).toBe("Assistant");
  });

  it("falls back to default brand colors when the hotel hasn't configured any", () => {
    const config = buildPublicWidgetConfig(makeContext({ hotel: makeHotel({ primary_color: null, secondary_color: null }) }));
    expect(config.primaryColor).toBe("#1A1D1A");
    expect(config.secondaryColor).toBe("#8A6A3E");
  });
});
