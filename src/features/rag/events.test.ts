import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadActiveHotelEvents, loadActiveBanner } from "./events";

/**
 * Minimal, STATEFUL fake of the one Postgres table these functions touch —
 * evaluates the actual filter predicates (eq/or/lte/gte) against an
 * in-memory row set, same discipline as this session's other real-filter
 * fakes (see e.g. activationTokenPersistence.test.ts) — the property under
 * test here IS the WHERE-clause logic (which events count as "active for
 * the prompt" vs "active for the banner"), not just "was .from() called".
 */
type Row = Record<string, unknown>;

function makeFakeSupabase(rows: Row[]): SupabaseClient {
  return {
    from() {
      const filters: Array<(row: Row) => boolean> = [];
      let orderCol: string | null = null;
      let limitN: number | null = null;
      let projection: string[] | null = null;

      function execute(): { data: Row[] | null; error: null } {
        let matched = rows.filter((row) => filters.every((f) => f(row)));
        if (orderCol) {
          const col = orderCol;
          matched = [...matched].sort((a, b) => ((a[col] as string) < (b[col] as string) ? 1 : -1));
        }
        if (limitN != null) matched = matched.slice(0, limitN);
        // Real PostgREST only returns the requested columns — mirrored here
        // since loadActiveBanner's own return shape (title/content only) is
        // part of what this test suite verifies.
        if (projection) {
          const cols = projection;
          matched = matched.map((row) => Object.fromEntries(cols.map((col) => [col, row[col]])));
        }
        return { data: matched, error: null };
      }

      const api = {
        select(columns: string) {
          projection = columns.split(",").map((c) => c.trim());
          return api;
        },
        eq(col: string, val: unknown) {
          filters.push((row) => row[col] === val);
          return api;
        },
        lte(col: string, val: string) {
          filters.push((row) => typeof row[col] === "string" && (row[col] as string) <= val);
          return api;
        },
        gte(col: string, val: string) {
          filters.push((row) => typeof row[col] === "string" && (row[col] as string) >= val);
          return api;
        },
        or(expr: string) {
          // Parses ONLY the exact shape loadActiveHotelEvents itself builds:
          // "type.eq.permanent,ends_at.gte.<iso>".
          const conditions = expr.split(",").map((c) => c.split("."));
          filters.push((row) =>
            conditions.some(([col, op, val]) => {
              if (op === "eq") return row[col] === val;
              if (op === "gte") return typeof row[col] === "string" && (row[col] as string) >= val;
              return false;
            })
          );
          return api;
        },
        order(col: string) {
          orderCol = col;
          return api;
        },
        limit(n: number) {
          limitN = n;
          return api;
        },
        maybeSingle() {
          const { data } = execute();
          return Promise.resolve({ data: data?.[0] ?? null, error: null });
        },
        returns() {
          return Promise.resolve(execute());
        },
        then(resolve: (v: { data: Row[] | null; error: null }) => void) {
          return Promise.resolve(execute()).then(resolve);
        },
      };
      return api;
    },
  } as unknown as SupabaseClient;
}

const HOTEL_ID = "hotel-a";
const TODAY = "2026-09-01";

describe("loadActiveHotelEvents — prompt context selection", () => {
  it("[permanent, active] included regardless of dates", async () => {
    const supabase = makeFakeSupabase([{ hotel_id: HOTEL_ID, type: "permanent", title: "Spa", content: "Accessible sans réserver.", starts_at: null, ends_at: null, is_active: true }]);
    const result = await loadActiveHotelEvents(supabase, HOTEL_ID, TODAY);
    expect(result.permanent).toHaveLength(1);
    expect(result.temporary).toHaveLength(0);
  });

  it("[temporary, currently active] included", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Fermeture spa", content: "Travaux.", starts_at: "2026-08-25", ends_at: "2026-09-05", is_active: true },
    ]);
    const result = await loadActiveHotelEvents(supabase, HOTEL_ID, TODAY);
    expect(result.temporary).toHaveLength(1);
  });

  it("[temporary, FUTURE — not yet started] still included (product decision: the model must be able to answer about a future date)", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Fermeture spa", content: "Travaux.", starts_at: "2026-09-12", ends_at: "2026-09-18", is_active: true },
    ]);
    const result = await loadActiveHotelEvents(supabase, HOTEL_ID, TODAY);
    expect(result.temporary).toHaveLength(1);
    expect(result.temporary[0].title).toBe("Fermeture spa");
  });

  it("[temporary, EXPIRED] excluded", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Ancienne soirée", content: "...", starts_at: "2026-08-01", ends_at: "2026-08-10", is_active: true },
    ]);
    const result = await loadActiveHotelEvents(supabase, HOTEL_ID, TODAY);
    expect(result.temporary).toHaveLength(0);
  });

  it("[disabled] excluded regardless of type or dates", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "permanent", title: "Spa", content: "...", starts_at: null, ends_at: null, is_active: false },
      { hotel_id: HOTEL_ID, type: "temporary", title: "Soirée", content: "...", starts_at: "2026-08-25", ends_at: "2026-09-05", is_active: false },
    ]);
    const result = await loadActiveHotelEvents(supabase, HOTEL_ID, TODAY);
    expect(result.permanent).toHaveLength(0);
    expect(result.temporary).toHaveLength(0);
  });

  it("[query failure] never throws — returns the empty shape", async () => {
    const supabase = {
      from() {
        return { select: () => ({ eq: () => ({ eq: () => ({ or: () => ({ returns: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) }) }) };
      },
    } as unknown as SupabaseClient;
    const result = await loadActiveHotelEvents(supabase, HOTEL_ID, TODAY);
    expect(result).toEqual({ permanent: [], temporary: [] });
  });
});

describe("loadActiveBanner — narrower gate than the prompt selection", () => {
  it("[currently within window, show_as_banner true] returned", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Fermeture spa", content: "Travaux.", starts_at: "2026-08-25", ends_at: "2026-09-05", is_active: true, show_as_banner: true, created_at: "2026-08-20T00:00:00Z" },
    ]);
    const banner = await loadActiveBanner(supabase, HOTEL_ID, TODAY);
    expect(banner).toEqual({ title: "Fermeture spa", content: "Travaux." });
  });

  it("[future event, not yet started] NEVER shown as a banner even though it's already visible to the chatbot's own prompt context", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Fermeture spa", content: "Travaux.", starts_at: "2026-09-12", ends_at: "2026-09-18", is_active: true, show_as_banner: true, created_at: "2026-08-20T00:00:00Z" },
    ]);
    expect(await loadActiveBanner(supabase, HOTEL_ID, TODAY)).toBeNull();
  });

  it("[expired event] no longer shown", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Ancienne soirée", content: "...", starts_at: "2026-08-01", ends_at: "2026-08-10", is_active: true, show_as_banner: true, created_at: "2026-07-20T00:00:00Z" },
    ]);
    expect(await loadActiveBanner(supabase, HOTEL_ID, TODAY)).toBeNull();
  });

  it("[show_as_banner = false] never shown, even if within the date window", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Fermeture spa", content: "Travaux.", starts_at: "2026-08-25", ends_at: "2026-09-05", is_active: true, show_as_banner: false, created_at: "2026-08-20T00:00:00Z" },
    ]);
    expect(await loadActiveBanner(supabase, HOTEL_ID, TODAY)).toBeNull();
  });

  it("[disabled event] never shown even if otherwise eligible", async () => {
    const supabase = makeFakeSupabase([
      { hotel_id: HOTEL_ID, type: "temporary", title: "Fermeture spa", content: "Travaux.", starts_at: "2026-08-25", ends_at: "2026-09-05", is_active: false, show_as_banner: true, created_at: "2026-08-20T00:00:00Z" },
    ]);
    expect(await loadActiveBanner(supabase, HOTEL_ID, TODAY)).toBeNull();
  });

  it("[permanent event] never eligible for a banner (structurally impossible per the schema, but defensive)", async () => {
    const supabase = makeFakeSupabase([{ hotel_id: HOTEL_ID, type: "permanent", title: "Spa", content: "...", starts_at: null, ends_at: null, is_active: true, show_as_banner: false, created_at: "2026-08-20T00:00:00Z" }]);
    expect(await loadActiveBanner(supabase, HOTEL_ID, TODAY)).toBeNull();
  });

  it("[query failure] never throws — returns null", async () => {
    const supabase = {
      from() {
        const chain = {
          select: () => chain,
          eq: () => chain,
          lte: () => chain,
          gte: () => chain,
          order: () => chain,
          limit: () => chain,
          maybeSingle: () => Promise.resolve({ data: null, error: { message: "boom" } }),
        };
        return chain;
      },
    } as unknown as SupabaseClient;
    expect(await loadActiveBanner(supabase, HOTEL_ID, TODAY)).toBeNull();
  });
});
