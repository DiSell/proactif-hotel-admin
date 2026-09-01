import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadActiveHotelEvents, loadActiveBanner } from "./events";
import { buildHotelInstructions } from "./prompt";
import type { ChatbotSettings, Hotel } from "@/types/database";

/**
 * End-to-end verification requested explicitly: 4 real-shaped events for
 * the SAME hotel (permanent active / temporary future / temporary
 * currently-active-with-banner / temporary expired), plus a 5th belonging
 * to a DIFFERENT hotel — exercising loadActiveHotelEvents, loadActiveBanner,
 * AND buildHotelInstructions together against the exact same fixture, so
 * the whole pipeline (DB selection -> prompt block) is checked in one
 * place, not just each function in isolation (already covered by
 * events.test.ts/prompt.test.ts individually).
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
          const conditions = expr.split(",").map((c) => c.split("."));
          filters.push((row) => conditions.some(([col, op, val]) => (op === "eq" ? row[col] === val : op === "gte" ? typeof row[col] === "string" && (row[col] as string) >= val : false)));
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
          return Promise.resolve({ data: execute().data?.[0] ?? null, error: null });
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

const HOTEL_A = "hotel-a";
const HOTEL_B = "hotel-b";
const TODAY = "2026-09-01";

const PERMANENT_ACTIVE = {
  hotel_id: HOTEL_A,
  type: "permanent",
  title: "Accès spa",
  content: "Le spa est accessible aux personnes extérieures à l'hôtel.",
  starts_at: null,
  ends_at: null,
  is_active: true,
  show_as_banner: false,
  created_at: "2026-01-01T00:00:00Z",
};

const TEMPORARY_FUTURE = {
  hotel_id: HOTEL_A,
  type: "temporary",
  title: "Fermeture spa (travaux)",
  content: "Le spa sera fermé pour travaux.",
  starts_at: "2026-09-12",
  ends_at: "2026-09-18",
  is_active: true,
  show_as_banner: true, // deliberately true — must NOT show as a banner yet, only once starts_at is reached
  created_at: "2026-08-01T00:00:00Z",
};

const TEMPORARY_ACTIVE_BANNER = {
  hotel_id: HOTEL_A,
  type: "temporary",
  title: "Soirée spéciale",
  content: "Soirée spéciale ce soir à partir de 20h.",
  starts_at: "2026-08-30",
  ends_at: "2026-09-02",
  is_active: true,
  show_as_banner: true,
  created_at: "2026-08-25T00:00:00Z",
};

const TEMPORARY_EXPIRED = {
  hotel_id: HOTEL_A,
  type: "temporary",
  title: "Ancienne offre",
  content: "Offre expirée depuis longtemps.",
  starts_at: "2026-07-01",
  ends_at: "2026-07-10",
  is_active: true,
  show_as_banner: true, // even with the flag set, it's expired: must never surface anywhere
  created_at: "2026-06-01T00:00:00Z",
};

const DISABLED_EVENT = {
  hotel_id: HOTEL_A,
  type: "permanent",
  title: "Info désactivée",
  content: "Ne doit jamais apparaître.",
  starts_at: null,
  ends_at: null,
  is_active: false,
  show_as_banner: false,
  created_at: "2026-01-01T00:00:00Z",
};

const OTHER_HOTEL_EVENT = {
  hotel_id: HOTEL_B,
  type: "permanent",
  title: "Info hôtel B",
  content: "Ne doit jamais apparaître pour l'hôtel A.",
  starts_at: null,
  ends_at: null,
  is_active: true,
  show_as_banner: false,
  created_at: "2026-01-01T00:00:00Z",
};

const ALL_ROWS = [PERMANENT_ACTIVE, TEMPORARY_FUTURE, TEMPORARY_ACTIVE_BANNER, TEMPORARY_EXPIRED, DISABLED_EVENT, OTHER_HOTEL_EVENT];

function makeHotel(): Hotel {
  return {
    id: HOTEL_A,
    name: "Le 1837",
    slug: "le-1837",
    widget_key: "ps_live_test",
    website: null,
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
  };
}

function makeSettings(): ChatbotSettings {
  return {
    id: "settings-a",
    hotel_id: HOTEL_A,
    welcome_message: "Bonjour !",
    fallback_message: "Je ne sais pas.",
    handoff_email: null,
    handoff_phone: null,
    tone: "warm",
    formality: "vous",
    response_length: "normal",
    commercial_proactivity: "discreet",
    custom_instructions: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

describe("4-event fixture — end-to-end verification (loadActiveHotelEvents -> buildHotelInstructions, and loadActiveBanner)", () => {
  it("[prompt selection] permanent + temporary-future + temporary-active are ALL present; expired and disabled are absent", async () => {
    const supabase = makeFakeSupabase(ALL_ROWS);
    const events = await loadActiveHotelEvents(supabase, HOTEL_A, TODAY);

    expect(events.permanent.map((e) => e.title)).toEqual(["Accès spa"]);
    const temporaryTitles = events.temporary.map((e) => e.title);
    expect(temporaryTitles).toContain("Fermeture spa (travaux)"); // future — still present
    expect(temporaryTitles).toContain("Soirée spéciale"); // currently active
    expect(temporaryTitles).not.toContain("Ancienne offre"); // expired — excluded
    expect(temporaryTitles).not.toContain("Info désactivée");
    expect(events.temporary).toHaveLength(2);
  });

  it("[cross-tenant isolation] hotel B's event never appears in hotel A's selection", async () => {
    const supabase = makeFakeSupabase(ALL_ROWS);
    const events = await loadActiveHotelEvents(supabase, HOTEL_A, TODAY);
    const allTitles = [...events.permanent, ...events.temporary].map((e) => e.title);
    expect(allTitles).not.toContain("Info hôtel B");
  });

  it("[banner] ONLY the currently-active temporary event is returned — the future one (show_as_banner=true but not started) is excluded", async () => {
    const supabase = makeFakeSupabase(ALL_ROWS);
    const banner = await loadActiveBanner(supabase, HOTEL_A, TODAY);
    expect(banner).toEqual({ title: "Soirée spéciale", content: "Soirée spéciale ce soir à partir de 20h." });
  });

  it("[banner never leaks the expired event] even though it also has show_as_banner=true", async () => {
    const supabase = makeFakeSupabase([TEMPORARY_EXPIRED]);
    expect(await loadActiveBanner(supabase, HOTEL_A, TODAY)).toBeNull();
  });

  it("[banner cross-tenant isolation] hotel B's event is never returned as hotel A's banner", async () => {
    const supabase = makeFakeSupabase([{ ...OTHER_HOTEL_EVENT, type: "temporary", show_as_banner: true, starts_at: TODAY, ends_at: TODAY }]);
    expect(await loadActiveBanner(supabase, HOTEL_A, TODAY)).toBeNull();
  });

  it("[no events at all] loadActiveHotelEvents returns the empty shape, loadActiveBanner returns null — matches an empty-DB hotel", async () => {
    const supabase = makeFakeSupabase([]);
    expect(await loadActiveHotelEvents(supabase, HOTEL_A, TODAY)).toEqual({ permanent: [], temporary: [] });
    expect(await loadActiveBanner(supabase, HOTEL_A, TODAY)).toBeNull();
  });

  it("[buildHotelInstructions] produces a clearly separated, readable events block from this exact fixture's selection", async () => {
    const supabase = makeFakeSupabase(ALL_ROWS);
    const events = await loadActiveHotelEvents(supabase, HOTEL_A, TODAY);
    const instructions = buildHotelInstructions({ hotel: makeHotel(), settings: makeSettings(), groundingMode: "grounded", events });

    // The block exists, as its own clearly-titled section...
    expect(instructions).toMatch(/ÉVÉNEMENTS ET INFORMATIONS DE L'ÉTABLISSEMENT :/);
    // ...separated from the rest by blank lines (buildHotelInstructions joins top-level blocks with "\n\n").
    const blocks = instructions.split("\n\n");
    const eventsBlockIndex = blocks.findIndex((b) => b.startsWith("ÉVÉNEMENTS ET INFORMATIONS DE L'ÉTABLISSEMENT :"));
    expect(eventsBlockIndex).toBeGreaterThan(-1);
    // ...contains all 3 legitimately-active facts...
    expect(instructions).toMatch(/Accès spa/);
    expect(instructions).toMatch(/Fermeture spa \(travaux\)/);
    expect(instructions).toMatch(/Soirée spéciale/);
    // ...and never the expired or disabled ones.
    expect(instructions).not.toMatch(/Ancienne offre/);
    expect(instructions).not.toMatch(/Info désactivée/);
    expect(instructions).not.toMatch(/Info hôtel B/);
    // Never mixed into the absolute rules / capabilities blocks above it.
    const absoluteRulesIndex = blocks.findIndex((b) => b.startsWith("Règles absolues"));
    expect(absoluteRulesIndex).toBeLessThan(eventsBlockIndex);
    expect(blocks[absoluteRulesIndex]).not.toMatch(/Accès spa|Soirée spéciale/);
  });
});
