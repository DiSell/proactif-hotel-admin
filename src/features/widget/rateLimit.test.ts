import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkWidgetGlobalRateLimit, checkWidgetSessionRateLimit, WIDGET_GLOBAL_RATE_LIMIT, WIDGET_SESSION_RATE_LIMIT } from "./rateLimit";

/**
 * The real rate limit decision lives in Postgres (widget_rate_limit_try_consume,
 * supabase/migrations/0006_widget_rate_limit.sql — proven at the SQL level
 * by supabase/tests/widget_rate_limit_check.sql, which nothing in this
 * repo's vitest runner can execute, no Postgres available). What CAN be
 * unit-tested for real here, with a fake client whose .rpc() is fully
 * controllable, is everything on the TypeScript side of that boundary:
 * that the correct bucket key/window/limit are sent, that the RPC's
 * allow/deny decision is surfaced faithfully, and — critically for fail-
 * closed behavior — that an RPC failure THROWS rather than silently
 * resolving to "allowed".
 */
function fakeSupabase(rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>) {
  return { rpc: vi.fn(rpcImpl) } as unknown as SupabaseClient;
}

describe("checkWidgetGlobalRateLimit", () => {
  it("[allowed] surfaces an allowed=true result from the RPC", async () => {
    const supabase = fakeSupabase(async () => ({
      data: [{ allowed: true, current_count: 5, window_start: "2026-01-01T00:00:00Z", retry_after_seconds: 0 }],
      error: null,
    }));
    const result = await checkWidgetGlobalRateLimit(supabase, "ps_live_abc");
    expect(result).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("[denied] surfaces an allowed=false result with a positive retryAfterSeconds", async () => {
    const supabase = fakeSupabase(async () => ({
      data: [{ allowed: false, current_count: 61, window_start: "2026-01-01T00:00:00Z", retry_after_seconds: 42 }],
      error: null,
    }));
    const result = await checkWidgetGlobalRateLimit(supabase, "ps_live_abc");
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 42 });
  });

  it("[bucket key + limits] calls the RPC with bucket_key='widget:<widgetKey>' and the documented global limit constants — never a second, ad-hoc set of numbers", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ allowed: true, current_count: 1, window_start: "x", retry_after_seconds: 0 }],
      error: null,
    }));
    const supabase = { rpc } as unknown as SupabaseClient;

    await checkWidgetGlobalRateLimit(supabase, "ps_live_abc");

    expect(rpc).toHaveBeenCalledWith("widget_rate_limit_try_consume", {
      p_bucket_key: "widget:ps_live_abc",
      p_window_seconds: WIDGET_GLOBAL_RATE_LIMIT.windowSeconds,
      p_max_requests: WIDGET_GLOBAL_RATE_LIMIT.maxRequests,
    });
  });

  it("[fail closed] an RPC error THROWS — never resolves to an 'allowed' result", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "connection reset" } }));
    await expect(checkWidgetGlobalRateLimit(supabase, "ps_live_abc")).rejects.toThrow(/connection reset/);
  });

  it("[fail closed] an empty result set THROWS — never silently treated as allowed", async () => {
    const supabase = fakeSupabase(async () => ({ data: [], error: null }));
    await expect(checkWidgetGlobalRateLimit(supabase, "ps_live_abc")).rejects.toThrow(/no rows/);
  });
});

describe("checkWidgetSessionRateLimit", () => {
  it("[bucket key] uses bucket_key='session:<widgetKey>:<hash>' and the documented session limit constants", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ allowed: true, current_count: 1, window_start: "x", retry_after_seconds: 0 }],
      error: null,
    }));
    const supabase = { rpc } as unknown as SupabaseClient;

    await checkWidgetSessionRateLimit(supabase, "ps_live_abc", "deadbeef".repeat(8));

    expect(rpc).toHaveBeenCalledWith("widget_rate_limit_try_consume", {
      p_bucket_key: `session:ps_live_abc:${"deadbeef".repeat(8)}`,
      p_window_seconds: WIDGET_SESSION_RATE_LIMIT.windowSeconds,
      p_max_requests: WIDGET_SESSION_RATE_LIMIT.maxRequests,
    });
  });

  it("[independent buckets] two different session hashes for the SAME widgetKey produce two different bucket keys — one session exhausting its quota cannot be mistaken for the global widget bucket or another session's bucket", async () => {
    const seenKeys: string[] = [];
    const rpc = vi.fn(async (_fn: string, args: { p_bucket_key: string }) => {
      seenKeys.push(args.p_bucket_key);
      return { data: [{ allowed: true, current_count: 1, window_start: "x", retry_after_seconds: 0 }], error: null };
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    await checkWidgetSessionRateLimit(supabase, "ps_live_abc", "a".repeat(64));
    await checkWidgetSessionRateLimit(supabase, "ps_live_abc", "b".repeat(64));
    await checkWidgetGlobalRateLimit(supabase, "ps_live_abc");

    expect(new Set(seenKeys).size).toBe(3);
    expect(seenKeys).toContain(`session:ps_live_abc:${"a".repeat(64)}`);
    expect(seenKeys).toContain(`session:ps_live_abc:${"b".repeat(64)}`);
    expect(seenKeys).toContain("widget:ps_live_abc");
  });

  it("[fail closed] an RPC error THROWS — same as the global check, never silently allowed", async () => {
    const supabase = fakeSupabase(async () => ({ data: null, error: { message: "timeout" } }));
    await expect(checkWidgetSessionRateLimit(supabase, "ps_live_abc", "a".repeat(64))).rejects.toThrow(/timeout/);
  });
});
