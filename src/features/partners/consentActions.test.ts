import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hashConsentToken } from "./consentToken";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "consentActions.ts"), "utf8");

/**
 * acceptPartnerConsent/declinePartnerConsent never call revalidatePath (see
 * consentActions.ts's own doc comment) so — unlike the requireHotelAccess-
 * guarded actions in actions.ts — these are safe to invoke for real here.
 */
function fakeAdminClient(row: { id: string } | null) {
  const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
  const select = vi.fn(() => ({ maybeSingle }));
  const eqStatus = vi.fn(() => ({ select }));
  const eqToken = vi.fn(() => ({ eq: eqStatus }));
  const update = vi.fn<(values: Record<string, unknown>) => { eq: typeof eqToken }>(() => ({ eq: eqToken }));
  const from = vi.fn(() => ({ update }));
  return { from, update, eqToken, eqStatus, select, maybeSingle };
}

const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

afterEach(() => {
  mockCreateAdminClient.mockReset();
});

describe("acceptPartnerConsent / declinePartnerConsent", () => {
  it("[no session dependency] never touches requireHotelAccess/requireClientAccess/requireSuperadmin — the token itself is the authorization", () => {
    // Starts after the file's own top-of-file doc comment, which
    // deliberately mentions those names in prose to explain why they're
    // absent — only the executable code below matters here.
    const code = source.slice(source.indexOf("async function respondToConsent"));
    expect(code).not.toMatch(/requireHotelAccess|requireClientAccess|requireSuperadmin/);
    expect(code).toMatch(/createAdminClient/);
  });

  it("[token re-hashed, never compared in plaintext] the update is scoped by consent_token_hash, not by the raw token", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    const token = "raw-token-value";
    await acceptPartnerConsent(token);

    expect(client.eqToken).toHaveBeenCalledWith("consent_token_hash", hashConsentToken(token));
    expect(client.eqToken).not.toHaveBeenCalledWith("consent_token_hash", token);
  });

  it("[never overwrites an existing answer] the update is ALSO scoped by consent_status = 'pending'", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    await acceptPartnerConsent("token-a");

    expect(client.eqStatus).toHaveBeenCalledWith("consent_status", "pending");
  });

  it("[accept] sets consent_status to \"accepted\"", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    const result = await acceptPartnerConsent("token-a");

    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ consent_status: "accepted" }));
    expect(result).toEqual({ ok: true, data: null });
  });

  it("[decline] sets consent_status to \"declined\"", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { declinePartnerConsent } = await import("./consentActions");

    const result = await declinePartnerConsent("token-a");

    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ consent_status: "declined" }));
    expect(result).toEqual({ ok: true, data: null });
  });

  it("[invalid or already-answered link] zero matching rows -> a clean error, never a throw", async () => {
    const client = fakeAdminClient(null);
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    const result = await acceptPartnerConsent("stale-token");

    expect(result.ok).toBe(false);
  });

  it("[opening hours supplied on accept] written verbatim, trimmed", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    await acceptPartnerConsent("token-a", "  Lun-Sam 12h-14h, 19h-22h  ");

    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ opening_hours: "Lun-Sam 12h-14h, 19h-22h" }));
  });

  it("[opening hours omitted on accept] never writes the column at all — an existing hotel-entered value is never wiped by a blank submission", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    await acceptPartnerConsent("token-a");

    const [update] = client.update.mock.calls[0];
    expect(update).not.toHaveProperty("opening_hours");
  });

  it("[opening hours blank on accept] never writes the column, same as omitted", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    await acceptPartnerConsent("token-a", "   ");

    const [update] = client.update.mock.calls[0];
    expect(update).not.toHaveProperty("opening_hours");
  });

  it("[decline never accepts opening hours or address] declinePartnerConsent's own signature has no such parameters — a declined partner is never recommended anyway", () => {
    const signatureStart = source.indexOf("export async function declinePartnerConsent");
    const signature = source.slice(signatureStart, source.indexOf(")", signatureStart));
    expect(signature).not.toMatch(/openingHours/);
    expect(signature).not.toMatch(/address/);
  });

  it("[address supplied on accept] written verbatim, trimmed", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    await acceptPartnerConsent("token-a", undefined, "  8 Rue Talairat  ");

    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ address: "8 Rue Talairat" }));
  });

  it("[address omitted on accept] never writes the column at all — an existing hotel-entered value is never wiped by a blank submission", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    await acceptPartnerConsent("token-a");

    const [update] = client.update.mock.calls[0];
    expect(update).not.toHaveProperty("address");
  });

  it("[address blank on accept] never writes the column, same as omitted", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerConsent } = await import("./consentActions");

    await acceptPartnerConsent("token-a", undefined, "   ");

    const [update] = client.update.mock.calls[0];
    expect(update).not.toHaveProperty("address");
  });
});
