import { describe, expect, it, vi } from "vitest";

function fakeSupabase(rows: unknown[]) {
  const select = vi.fn<(columns: string) => unknown>(() => ({
    eq: () => ({
      order: () => ({
        order: () => ({
          returns: async () => ({ data: rows, error: null }),
        }),
      }),
    }),
  }));
  const from = vi.fn(() => ({ select }));
  return { from, select };
}

/**
 * listHotelPartners is shared between the back-office and the client portal
 * (see actions.ts's own comment on requireHotelAccess) — back-office and
 * the client portal use different session cookies
 * (lib/supabase/cookieScope.ts), so this function requires an explicit
 * `supabase` argument (no default, no fallback) — the caller must always
 * hand in the client bound to its own scope.
 */
describe("listHotelPartners — required supabase client, no default", () => {
  it("[client provided] uses it directly for the query", async () => {
    const { listHotelPartners } = await import("./queries");
    const supabase = fakeSupabase([]);

    await listHotelPartners("hotel-a", supabase as never);

    expect(supabase.from).toHaveBeenCalledWith("hotel_partners");
  });

  it("[explicit column list, never select(\"*\")] consent_token_hash is never requested — it must never reach a Client Component even as a hash", async () => {
    const { listHotelPartners } = await import("./queries");
    const supabase = fakeSupabase([]);

    await listHotelPartners("hotel-a", supabase as never);

    const [columns] = supabase.select.mock.calls[0];
    expect(columns).not.toBe("*");
    expect(columns).not.toMatch(/consent_token_hash/);
    expect(columns).toMatch(/\bemail\b/);
    expect(columns).toMatch(/\bconsent_status\b/);
    expect(columns).toMatch(/\bopening_hours\b/);
  });

  it("[request_phone_e164 included] this projection feeds ONLY the authorized management UI (never the chatbot, which reads hotel_partners through its own, separate query) — see this file's own PARTNER_COLUMNS doc comment", async () => {
    const { listHotelPartners } = await import("./queries");
    const supabase = fakeSupabase([]);

    await listHotelPartners("hotel-a", supabase as never);

    const [columns] = supabase.select.mock.calls[0];
    expect(columns).toMatch(/\brequest_phone_e164\b/);
    expect(columns).toMatch(/\bphone\b/); // the public field remains present too, independently
  });

  it("[whatsapp_consent_status/requested_at/responded_at included, whatsapp_consent_token_hash excluded] same discipline as the recommendation-consent columns above", async () => {
    const { listHotelPartners } = await import("./queries");
    const supabase = fakeSupabase([]);

    await listHotelPartners("hotel-a", supabase as never);

    const [columns] = supabase.select.mock.calls[0];
    expect(columns).toMatch(/\bwhatsapp_consent_status\b/);
    expect(columns).toMatch(/\bwhatsapp_consent_requested_at\b/);
    expect(columns).toMatch(/\bwhatsapp_consent_responded_at\b/);
    expect(columns).not.toMatch(/whatsapp_consent_token_hash/);
  });
});
