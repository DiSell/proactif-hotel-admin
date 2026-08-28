import { afterEach, describe, expect, it, vi } from "vitest";
import { hashConsentToken } from "./consentToken";

function fakeAdminClient(
  partnerRow: { name: string; hotel_id: string; consent_status: string; opening_hours: string | null; address: string | null } | null,
  hotelRow: { name: string } | null
) {
  const partnerMaybeSingle = vi.fn(async () => ({ data: partnerRow, error: null }));
  const partnerEq = vi.fn(() => ({ maybeSingle: partnerMaybeSingle }));
  const partnerSelect = vi.fn(() => ({ eq: partnerEq }));

  const hotelMaybeSingle = vi.fn(async () => ({ data: hotelRow, error: null }));
  const hotelEq = vi.fn(() => ({ maybeSingle: hotelMaybeSingle }));
  const hotelSelect = vi.fn(() => ({ eq: hotelEq }));

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

describe("getPartnerConsentRequest", () => {
  it("[empty token] returns null without ever calling the database", async () => {
    const { getPartnerConsentRequest } = await import("./consentLookup");
    const result = await getPartnerConsentRequest("");
    expect(result).toBeNull();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("[token re-hashed, never compared in plaintext] looks the partner up by consent_token_hash, not by the raw token", async () => {
    const client = fakeAdminClient(
      { name: "Le Bistrot", hotel_id: "hotel-1", consent_status: "pending", opening_hours: null, address: null },
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequest } = await import("./consentLookup");

    const token = "raw-token-value";
    await getPartnerConsentRequest(token);

    expect(client.partnerEq).toHaveBeenCalledWith("consent_token_hash", hashConsentToken(token));
    expect(client.partnerEq).not.toHaveBeenCalledWith("consent_token_hash", token);
  });

  it("[success] returns the partner name, hotel name, current status, opening hours, and address", async () => {
    const client = fakeAdminClient(
      { name: "Le Bistrot", hotel_id: "hotel-1", consent_status: "pending", opening_hours: "Lun-Sam 12h-14h, 19h-22h", address: "8 Rue Talairat" },
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequest } = await import("./consentLookup");

    const result = await getPartnerConsentRequest("token-a");

    expect(result).toEqual({
      partnerName: "Le Bistrot",
      hotelName: "Hôtel du Parc",
      status: "pending",
      openingHours: "Lun-Sam 12h-14h, 19h-22h",
      address: "8 Rue Talairat",
    });
  });

  it("[no opening hours or address set yet] both null, never fabricated", async () => {
    const client = fakeAdminClient(
      { name: "Le Bistrot", hotel_id: "hotel-1", consent_status: "pending", opening_hours: null, address: null },
      { name: "Hôtel du Parc" }
    );
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequest } = await import("./consentLookup");

    const result = await getPartnerConsentRequest("token-a");

    expect(result?.openingHours).toBeNull();
    expect(result?.address).toBeNull();
  });

  it("[unknown token] no matching partner -> null", async () => {
    const client = fakeAdminClient(null, null);
    mockCreateAdminClient.mockReturnValue(client);
    const { getPartnerConsentRequest } = await import("./consentLookup");

    const result = await getPartnerConsentRequest("unknown-token");

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
});
