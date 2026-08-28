import { afterEach, describe, expect, it, vi } from "vitest";
import { hashConsentToken } from "./consentToken";

type PartnerRow = {
  name: string;
  hotel_id: string;
  consent_status: string;
  opening_hours: string | null;
  address: string | null;
  whatsapp_consent_status: string;
  request_phone_e164: string | null;
} | null;

/**
 * Simulates the two independent lookups getPartnerConsentRequests tries in
 * order (consent_token_hash first, then whatsapp_consent_token_hash) — see
 * that function's own doc comment on why a single token can resolve either
 * column. `byRecommendationRow` and `byWhatsappRow` are deliberately
 * separate parameters so tests can prove EACH query only ever runs against
 * its own column, and that the second query only runs when the first finds
 * nothing.
 */
function fakeAdminClient(byRecommendationRow: PartnerRow, byWhatsappRow: PartnerRow, hotelRow: { name: string } | null) {
  const hotelMaybeSingle = vi.fn(async () => ({ data: hotelRow, error: null }));
  const hotelEq = vi.fn(() => ({ maybeSingle: hotelMaybeSingle }));
  const hotelSelect = vi.fn(() => ({ eq: hotelEq }));

  const partnerEq = vi.fn((column: string) => ({
    maybeSingle: async () => ({ data: column === "consent_token_hash" ? byRecommendationRow : byWhatsappRow, error: null }),
  }));
  const partnerSelect = vi.fn(() => ({ eq: partnerEq }));

  const from = vi.fn((table: string) => (table === "hotel_partners" ? { select: partnerSelect } : { select: hotelSelect }));
  return { from, partnerSelect, partnerEq, hotelSelect, hotelEq };
}

const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

afterEach(() => {
  mockCreateAdminClient.mockReset();
});

describe("getPartnerConsentRequests — ONE token, TWO independent consent statuses on the SAME returned shape", () => {
  it("[empty token] returns null without ever calling the database", async () => {
    const { getPartnerConsentRequests } = await import("./consentLookup");
    const result = await getPartnerConsentRequests("");
    expect(result).toBeNull();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("[token re-hashed, never compared in plaintext] looks the partner up by hash, not by the raw token", async () => {
    const client = fakeAdminClient(
      { name: "Le Bistrot", hotel_id: "hotel-1", consent_status: "pending", opening_hours: null, address: null, whatsapp_consent_status: "not_requested", request_phone_e164: null },
      null,
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequests } = await import("./consentLookup");

    const token = "raw-token-value";
    await getPartnerConsentRequests(token);

    expect(client.partnerEq).toHaveBeenCalledWith("consent_token_hash", hashConsentToken(token));
    expect(client.partnerEq).not.toHaveBeenCalledWith("consent_token_hash", token);
  });

  it("[found via consent_token_hash] the whatsapp_consent_token_hash lookup is never attempted — the first match short-circuits", async () => {
    const client = fakeAdminClient(
      { name: "Le Bistrot", hotel_id: "hotel-1", consent_status: "pending", opening_hours: null, address: null, whatsapp_consent_status: "not_requested", request_phone_e164: null },
      null,
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequests } = await import("./consentLookup");

    await getPartnerConsentRequests("token-a");

    expect(client.partnerEq).not.toHaveBeenCalledWith("whatsapp_consent_token_hash", expect.anything());
  });

  it("[found via whatsapp_consent_token_hash] falls back to the second column only when the first finds nothing — same partner row either way", async () => {
    const client = fakeAdminClient(
      null,
      { name: "Le Bistrot", hotel_id: "hotel-1", consent_status: "not_requested", opening_hours: null, address: null, whatsapp_consent_status: "pending", request_phone_e164: "+33612345678" },
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequests } = await import("./consentLookup");

    const result = await getPartnerConsentRequests("token-a");

    expect(client.partnerEq).toHaveBeenCalledWith("consent_token_hash", expect.anything());
    expect(client.partnerEq).toHaveBeenCalledWith("whatsapp_consent_token_hash", expect.anything());
    expect(result?.whatsapp.status).toBe("pending");
  });

  it("[success] returns BOTH consent blocks independently — recommendation status/openingHours/address, whatsapp status/requestPhoneE164", async () => {
    const client = fakeAdminClient(
      {
        name: "Le Bistrot",
        hotel_id: "hotel-1",
        consent_status: "pending",
        opening_hours: "Lun-Sam 12h-14h, 19h-22h",
        address: "8 Rue Talairat",
        whatsapp_consent_status: "accepted",
        request_phone_e164: "+33612345678",
      },
      null,
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequests } = await import("./consentLookup");

    const result = await getPartnerConsentRequests("token-a");

    expect(result).toEqual({
      partnerName: "Le Bistrot",
      hotelName: "Hôtel du Parc",
      recommendation: { status: "pending", openingHours: "Lun-Sam 12h-14h, 19h-22h", address: "8 Rue Talairat" },
      whatsapp: { status: "accepted", requestPhoneE164: "+33612345678" },
    });
  });

  it("[each consent's status is independent of the other] recommendation accepted + whatsapp not_requested is a valid, returned combination — never conflated into one field", async () => {
    const client = fakeAdminClient(
      { name: "Le Bistrot", hotel_id: "hotel-1", consent_status: "accepted", opening_hours: null, address: null, whatsapp_consent_status: "not_requested", request_phone_e164: null },
      null,
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequests } = await import("./consentLookup");

    const result = await getPartnerConsentRequests("token-a");

    expect(result?.recommendation.status).toBe("accepted");
    expect(result?.whatsapp.status).toBe("not_requested");
  });

  it("[unknown token] no matching partner in EITHER column -> null", async () => {
    const client = fakeAdminClient(null, null, null);
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequests } = await import("./consentLookup");

    const result = await getPartnerConsentRequests("unknown-token");

    expect(result).toBeNull();
  });

  it("[no session dependency] uses service_role (createAdminClient), never a session-bound client", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "consentLookup.ts"), "utf8");
    expect(source).toMatch(/createAdminClient/);
    expect(source).not.toMatch(/requireHotelAccess|requireClientAccess|requireSuperadmin/);
  });

  it("[never selects either token hash back out] the hashes are never returned to any caller", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "consentLookup.ts"), "utf8");
    expect(source).not.toMatch(/\.select\([^)]*token_hash/);
  });

  it("[no second lookup function exists any more] the previous split getPartnerConsentRequest/getPartnerTransactionalConsentRequest were merged into this one function", async () => {
    const consentLookup = await import("./consentLookup");
    expect(consentLookup).not.toHaveProperty("getPartnerConsentRequest");
    expect(consentLookup).not.toHaveProperty("getPartnerTransactionalConsentRequest");
  });
});
