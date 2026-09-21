import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSelectedRoomPhotos } from "./roomPhotos";

/**
 * CATÉGORIES INFORMATION CLIQUABLES chantier — real invocation of the
 * extracted helper (a pure extraction from buildRoomRecommendation, see
 * answer.groundingMode.test.ts's own updated describe block for the
 * call-site side of this). Captures exactly which table/columns/filters/
 * order this function issues, real invocation rather than source-text —
 * possible here because the function takes an injected SupabaseClient.
 */
function fakeSupabase(calls: { table?: string; columns?: string; eqs?: [string, unknown][]; order?: [string, unknown] }, result: { data: unknown; error: unknown }): SupabaseClient {
  return {
    from(table: string) {
      calls.table = table;
      return {
        select(columns: string) {
          calls.columns = columns;
          calls.eqs = [];
          const node = {
            eq(column: string, value: unknown) {
              calls.eqs!.push([column, value]);
              return node;
            },
            order: async (column: string, options: unknown) => {
              calls.order = [column, options];
              return result;
            },
          };
          return node;
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("loadSelectedRoomPhotos", () => {
  it("[exact table/columns/filters/order] hotel_id, accommodation_type_id, is_selected=true, ORDER BY position ascending — nothing more, nothing less", async () => {
    const calls: { table?: string; columns?: string; eqs?: [string, unknown][]; order?: [string, unknown] } = {};
    const supabase = fakeSupabase(calls, { data: [], error: null });
    await loadSelectedRoomPhotos(supabase, "hotel-1", "acc-1");

    expect(calls.table).toBe("room_photos");
    expect(calls.columns).toBe("photo_url, alt_text");
    expect(calls.eqs).toEqual([
      ["hotel_id", "hotel-1"],
      ["accommodation_type_id", "acc-1"],
      ["is_selected", true],
    ]);
    expect(calls.order).toEqual(["position", { ascending: true }]);
  });

  it("[maps photo_url/alt_text -> url/alt, preserving the returned order]", async () => {
    const supabase = fakeSupabase({}, {
      data: [
        { photo_url: "https://cdn.example.com/2.jpg", alt_text: "Deuxième" },
        { photo_url: "https://cdn.example.com/1.jpg", alt_text: null },
      ],
      error: null,
    });
    const photos = await loadSelectedRoomPhotos(supabase, "hotel-1", "acc-1");
    expect(photos).toEqual([
      { url: "https://cdn.example.com/2.jpg", alt: "Deuxième" },
      { url: "https://cdn.example.com/1.jpg", alt: null },
    ]);
  });

  it("[null data] resolves to an empty array, never throws/null", async () => {
    const supabase = fakeSupabase({}, { data: null, error: null });
    const photos = await loadSelectedRoomPhotos(supabase, "hotel-1", "acc-1");
    expect(photos).toEqual([]);
  });
});
