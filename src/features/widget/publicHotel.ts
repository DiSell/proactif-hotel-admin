import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { bookingActionModeSchema, hostBookingTriggerSchema, parseHostBookingTrigger } from "@/features/hotels/hostBookingTrigger";
import type { Hotel, WidgetIcon, WidgetPosition, WidgetSettings } from "@/types/database";

// Exported so the client portal's chatbot-personalization form
// (features/client/schema.ts) can offer the exact same value as its
// "Réinitialiser la valeur par défaut" reset target — this is the one
// value the real public widget actually falls back to (see
// resolvePublicWidgetContext below), so it's the only correct default to
// reuse rather than inventing a second one.
export const DEFAULT_WELCOME_MESSAGE = "Bonjour ! Comment puis-je vous aider ?";
const DEFAULT_POSITION: WidgetPosition = "bottom-right";
const DEFAULT_ICON: WidgetIcon = "chat";

/**
 * Everything a public widget route needs about one hotel, resolved
 * EXCLUSIVELY from widget_key — hotelId is never accepted from the client,
 * anywhere in this module or its callers. widget_key is a public, non-secret
 * identifier (see lib/widgetKey.ts's generateWidgetKey), but resolving it to
 * a real hotel row still only ever happens server-side, here.
 *
 * Callers supply the Supabase client (service-role — createAdminClient()),
 * rather than this module constructing its own: hotels/chatbot_settings/
 * widget_settings/accommodation_types/room_photos/messages/conversations/
 * knowledge_chunks all carry RLS scoped to is_superadmin() plus an explicit
 * `revoke all ... from anon` (0001_init.sql/0002_rag.sql) — an anonymous
 * visitor's session-bound client can read none of them, and the
 * match_knowledge_chunks() RPC itself additionally revokes execute from
 * `public`. There is no anon-safe RLS path today; fixing that properly
 * would need a migration (out of scope). Tenant isolation for the public
 * widget therefore rests entirely on this module resolving hotelId
 * server-side and every caller using that resolved id — never anything the
 * client supplies. Injecting the client (instead of constructing it here)
 * lets one request build a single client and reuse it for every query,
 * including this resolution step, and lets this function be unit-tested
 * with a fake client.
 */
export interface PublicWidgetContext {
  hotelId: string;
  hotel: Hotel;
  widgetDisplay: {
    welcomeMessage: string;
    position: WidgetPosition;
    icon: WidgetIcon;
  };
}

/**
 * The ONLY place a public request resolves widget_key -> hotel. Reusable by
 * every widget route (config, chat) so the gating rule below is defined
 * once, not re-implemented per route.
 *
 * Returns null — never a distinct error/reason — for every disqualifying
 * case: unknown widget_key, a hotel not yet published (`status` other than
 * "active", e.g. "draft" during onboarding — see hotels.status,
 * 0001_init.sql), the assistant explicitly turned off
 * (`assistant_enabled = false`, the wizard's "Assistant actif" toggle), or
 * the widget itself explicitly deactivated (`widget_settings.is_active =
 * false`, the "Widget actif" toggle in WidgetSettingsForm.tsx). Collapsing
 * all of these to the same null/404 response is deliberate: a distinguishable
 * "valid key but disabled" response would let someone probe which keys are
 * real.
 *
 * THROWS — never returns null — on a genuine Supabase error (connectivity,
 * permissions, etc.): that is a service problem, not "this widget doesn't
 * exist", and callers must fail closed (503), not treat it as a 404. Only
 * the explicit "no matching row" case (no error, just an empty result)
 * resolves to null.
 *
 * No widget_settings row at all (a hotel that never visited the widget
 * settings page — createHotel never inserts one) is treated as active with
 * the same defaults the DB column and the admin form itself already use
 * (widget_settings.is_active defaults to true; WidgetSettingsForm falls
 * back to the same welcome_message/position/icon defaults when settings is
 * null) — never as "inactive by absence".
 */
export async function resolvePublicWidgetContext(widgetKey: string, supabase: SupabaseClient): Promise<PublicWidgetContext | null> {
  if (!widgetKey || typeof widgetKey !== "string") return null;

  const { data: hotel, error: hotelError } = await supabase.from("hotels").select("*").eq("widget_key", widgetKey).maybeSingle<Hotel>();
  if (hotelError) {
    throw new Error(`resolvePublicWidgetContext: hotels lookup failed: ${hotelError.message}`);
  }
  if (!hotel) return null;
  if (hotel.status !== "active" || !hotel.assistant_enabled) return null;

  const { data: widgetSettings, error: settingsError } = await supabase
    .from("widget_settings")
    .select("*")
    .eq("hotel_id", hotel.id)
    .maybeSingle<WidgetSettings>();
  if (settingsError) {
    throw new Error(`resolvePublicWidgetContext: widget_settings lookup failed: ${settingsError.message}`);
  }

  if (widgetSettings && !widgetSettings.is_active) return null;

  return {
    hotelId: hotel.id,
    hotel,
    widgetDisplay: {
      welcomeMessage: widgetSettings?.welcome_message || DEFAULT_WELCOME_MESSAGE,
      position: widgetSettings?.position ?? DEFAULT_POSITION,
      icon: widgetSettings?.icon ?? DEFAULT_ICON,
    },
  };
}

/**
 * Strict output schema for the public config payload — deliberately NOT
 * `.passthrough()`: an accidental extra key (e.g. a careless `{...hotel}`
 * spread introduced later) throws instead of silently leaking, since this
 * is the one boundary where an internal row shape meets an unauthenticated
 * caller. Never includes hotelId, credential_reference, profiles, or
 * anything integration/reservation-related — none of those are read by
 * buildPublicWidgetConfig below in the first place.
 */
export const publicWidgetConfigSchema = z
  .object({
    hotelName: z.string(),
    assistantName: z.string(),
    welcomeMessage: z.string(),
    primaryColor: z.string(),
    secondaryColor: z.string(),
    position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]),
    icon: z.enum(["chat", "help", "message"]),
    logoUrl: z.string().nullable(),
    // Consumed by public/widget.js (fetched independently from the host
    // page, never relayed through the iframe's postMessage) to decide
    // whether/how to trigger the hotel's own booking module. The selector
    // inside hostBookingTrigger is not a secret, but it IS trusted,
    // admin-configured data — never derived from, or influenced by,
    // anything a visitor or the model supplies.
    bookingActionMode: bookingActionModeSchema,
    hostBookingTrigger: hostBookingTriggerSchema.nullable(),
  })
  .strict();

export type PublicWidgetConfig = z.infer<typeof publicWidgetConfigSchema>;

/** The only place a PublicWidgetConfig is constructed — parsed through publicWidgetConfigSchema before ever leaving this module. */
export function buildPublicWidgetConfig(context: PublicWidgetContext): PublicWidgetConfig {
  return publicWidgetConfigSchema.parse({
    hotelName: context.hotel.name,
    assistantName: context.hotel.assistant_name || "Assistant",
    welcomeMessage: context.widgetDisplay.welcomeMessage,
    primaryColor: context.hotel.primary_color || "#1A1D1A",
    secondaryColor: context.hotel.secondary_color || "#8A6A3E",
    position: context.widgetDisplay.position,
    icon: context.widgetDisplay.icon,
    logoUrl: context.hotel.logo_url,
    bookingActionMode: context.hotel.booking_action_mode,
    // Only ever exposed for "host_widget" — irrelevant/stale DB content is
    // never leaked when the hotel is actually in "url" mode. Re-validated
    // here (not trusted as already-correct just because it's in the row)
    // — a malformed/legacy value silently becomes null, same fail-safe
    // discipline as buildBookingAction.
    hostBookingTrigger: context.hotel.booking_action_mode === "host_widget" ? parseHostBookingTrigger(context.hotel.host_booking_trigger) : null,
  });
}
