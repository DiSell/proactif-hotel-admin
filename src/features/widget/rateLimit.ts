import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Distributed rate limiting for the public widget, backed by
 * supabase/migrations/0006_widget_rate_limit.sql — replaces the previous
 * in-memory, single-process limiter, which could not share counters across
 * server instances. That matters specifically here because widget_key is a
 * PUBLIC identifier (visible in the embed snippet on any page that uses
 * it), and every chat request triggers a real, billed OpenAI call — an
 * in-memory counter is not a real cost backstop the moment more than one
 * instance is running.
 *
 * Two independent quota levels, per widgetKey (see widget_rate_limit_try_consume's
 * bucket_key prefixes — 'widget:' and 'session:' can never collide):
 *   - WIDGET_GLOBAL_RATE_LIMIT: caps a single hotel's total worst-case
 *     OpenAI cost exposure, regardless of how many distinct visitor
 *     sessions are used against it (a single visitor and a hundred
 *     visitors are both bounded by the same hotel-wide ceiling).
 *   - WIDGET_SESSION_RATE_LIMIT: stops one visitor session from
 *     monopolizing that shared quota, independent of the global cap.
 * Deliberately NOT keyed by IP: proxy/CDN headers are infrastructure-
 * dependent and easy to spoof or simply absent depending on deployment —
 * the global widget-wide quota is the real backstop either way, and stays
 * meaningful even if a session-level identifier were somehow bypassed.
 */
export const WIDGET_GLOBAL_RATE_LIMIT = { windowSeconds: 60, maxRequests: 60 } as const;
export const WIDGET_SESSION_RATE_LIMIT = { windowSeconds: 60, maxRequests: 10 } as const;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface RateLimitRow {
  allowed: boolean;
  current_count: number;
  window_start: string;
  retry_after_seconds: number;
}

/**
 * Throws on any failure to reach/execute the RPC (network error, RPC
 * error, unexpected empty result) — NEVER returns a synthetic "allowed"
 * result on failure. Callers (see the chat route) must fail closed: an
 * exception from this function means the request is rejected, not that
 * rate limiting is silently skipped.
 */
async function tryConsume(supabase: SupabaseClient, bucketKey: string, windowSeconds: number, maxRequests: number): Promise<RateLimitResult> {
  const { data, error } = await supabase.rpc("widget_rate_limit_try_consume", {
    p_bucket_key: bucketKey,
    p_window_seconds: windowSeconds,
    p_max_requests: maxRequests,
  });

  if (error) {
    throw new Error(`widget_rate_limit_try_consume RPC failed: ${error.message}`);
  }
  const rows = data as RateLimitRow[] | null;
  if (!rows || rows.length === 0) {
    throw new Error("widget_rate_limit_try_consume RPC returned no rows");
  }

  return { allowed: rows[0].allowed, retryAfterSeconds: rows[0].retry_after_seconds };
}

/** bucket_key = 'widget:<widgetKey>' — see the migration's doc comment for why this prefix can never collide with the session-level bucket below. */
export function checkWidgetGlobalRateLimit(supabase: SupabaseClient, widgetKey: string): Promise<RateLimitResult> {
  return tryConsume(supabase, `widget:${widgetKey}`, WIDGET_GLOBAL_RATE_LIMIT.windowSeconds, WIDGET_GLOBAL_RATE_LIMIT.maxRequests);
}

/** bucket_key = 'session:<widgetKey>:<sessionTokenHash>' — namespaced by widgetKey too, not just the session hash, as cheap extra insurance against any cross-hotel bucket collision. */
export function checkWidgetSessionRateLimit(supabase: SupabaseClient, widgetKey: string, sessionTokenHash: string): Promise<RateLimitResult> {
  return tryConsume(
    supabase,
    `session:${widgetKey}:${sessionTokenHash}`,
    WIDGET_SESSION_RATE_LIMIT.windowSeconds,
    WIDGET_SESSION_RATE_LIMIT.maxRequests
  );
}
