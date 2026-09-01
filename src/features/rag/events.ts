import type { SupabaseClient } from "@supabase/supabase-js";
import type { HotelEvent } from "@/types/database";

type PromptEventRow = Pick<HotelEvent, "type" | "title" | "content" | "starts_at" | "ends_at">;

export interface ActiveHotelEvents {
  permanent: Pick<PromptEventRow, "title" | "content">[];
  /** Sorted by starts_at ascending — soonest/current first. Includes FUTURE events on purpose, see this module's own header comment. */
  temporary: Pick<PromptEventRow, "title" | "content" | "starts_at" | "ends_at">[];
}

const EMPTY_EVENTS: ActiveHotelEvents = { permanent: [], temporary: [] };

/**
 * Loaded for the chatbot's PROMPT CONTEXT (features/rag/prompt.ts::buildEventsGuidance,
 * called from answer.ts::answerQuestion) — deliberately BROADER than the
 * banner selection below:
 *   - permanent: is_active = true, no date filtering at all (no expiry
 *     concept for this type).
 *   - temporary: is_active = true AND NOT YET EXPIRED (ends_at >= today).
 *     This INCLUDES events that haven't started yet (starts_at > today) —
 *     explicit product decision: a visitor may ask about a future date
 *     ("le spa sera-t-il fermé le 15 ?") before that period begins, and the
 *     model must be able to answer from the event's own date range. Only a
 *     genuinely PAST event (ends_at < today) is excluded.
 *   - A disabled event (is_active = false) is excluded regardless of type
 *     or dates.
 *
 * Never throws — a query failure here must never break an otherwise-working
 * chat turn (same "best-effort enrichment" discipline as
 * answer.ts::answerQuestion's own stay-request resolution try/catch); it
 * logs and returns an empty result instead, so buildEventsGuidance simply
 * omits the block for this turn.
 */
export async function loadActiveHotelEvents(supabase: SupabaseClient, hotelId: string, todayIso: string): Promise<ActiveHotelEvents> {
  const { data, error } = await supabase
    .from("hotel_events")
    .select("type, title, content, starts_at, ends_at")
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .or(`type.eq.permanent,ends_at.gte.${todayIso}`)
    .returns<PromptEventRow[]>();

  if (error) {
    console.error("loadActiveHotelEvents: query failed", { hotelId, message: error.message });
    return EMPTY_EVENTS;
  }

  const rows = data ?? [];
  return {
    permanent: rows.filter((row) => row.type === "permanent"),
    temporary: rows.filter((row) => row.type === "temporary").sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? "")),
  };
}

export interface ActiveBanner {
  title: string;
  content: string;
}

/**
 * Loaded for the PUBLIC WIDGET's banner (features/widget/publicHotel.ts,
 * called from the /api/widget/[widgetKey]/config route) — a NARROWER,
 * separate gate from loadActiveHotelEvents above: only a 'temporary' event
 * with show_as_banner = true AND the current date strictly within
 * [starts_at, ends_at]. A future event (not yet started) is deliberately
 * EXCLUDED here even though it may already be visible to the chatbot's own
 * prompt context above — the banner is a "this is happening now" surface,
 * never a "coming soon" announcement in this MVP.
 *
 * At most one banner is ever returned (MVP: no stacking) — the most
 * recently created eligible event wins, same "simple, not a notification
 * system" scope as the product spec. Never throws — same fail-safe
 * discipline as loadActiveHotelEvents.
 */
export async function loadActiveBanner(supabase: SupabaseClient, hotelId: string, todayIso: string): Promise<ActiveBanner | null> {
  const { data, error } = await supabase
    .from("hotel_events")
    .select("title, content")
    .eq("hotel_id", hotelId)
    .eq("is_active", true)
    .eq("type", "temporary")
    .eq("show_as_banner", true)
    .lte("starts_at", todayIso)
    .gte("ends_at", todayIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<ActiveBanner>();

  if (error) {
    console.error("loadActiveBanner: query failed", { hotelId, message: error.message });
    return null;
  }
  return data ?? null;
}
