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

describe("acceptPartnerTransactionalConsent / declinePartnerTransactionalConsent — DISTINCT from the recommendation consent above", () => {
  it("[no session dependency]", () => {
    const code = source.slice(source.indexOf("async function respondToTransactionalConsent"));
    expect(code).not.toMatch(/requireHotelAccess|requireClientAccess|requireSuperadmin/);
    expect(code).toMatch(/createAdminClient/);
  });

  it("[scoped by whatsapp_consent_token_hash, NEVER consent_token_hash]", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerTransactionalConsent } = await import("./consentActions");

    const token = "raw-token-value";
    await acceptPartnerTransactionalConsent(token);

    expect(client.eqToken).toHaveBeenCalledWith("whatsapp_consent_token_hash", hashConsentToken(token));
    expect(client.eqToken).not.toHaveBeenCalledWith("consent_token_hash", expect.anything());
    expect(client.eqToken).not.toHaveBeenCalledWith("whatsapp_consent_token_hash", token);
  });

  it("[never overwrites an existing answer] scoped ALSO by whatsapp_consent_status = 'pending', never consent_status", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerTransactionalConsent } = await import("./consentActions");

    await acceptPartnerTransactionalConsent("token-a");

    expect(client.eqStatus).toHaveBeenCalledWith("whatsapp_consent_status", "pending");
    expect(client.eqStatus).not.toHaveBeenCalledWith("consent_status", expect.anything());
  });

  it("[accept] sets whatsapp_consent_status to \"accepted\", never touches consent_status", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerTransactionalConsent } = await import("./consentActions");

    const result = await acceptPartnerTransactionalConsent("token-a");

    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ whatsapp_consent_status: "accepted" }));
    const [update] = client.update.mock.calls[0];
    expect(update).not.toHaveProperty("consent_status");
    expect(result).toEqual({ ok: true, data: null });
  });

  it("[decline] sets whatsapp_consent_status to \"declined\", never touches consent_status", async () => {
    const client = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client);
    const { declinePartnerTransactionalConsent } = await import("./consentActions");

    const result = await declinePartnerTransactionalConsent("token-a");

    expect(client.update).toHaveBeenCalledWith(expect.objectContaining({ whatsapp_consent_status: "declined" }));
    const [update] = client.update.mock.calls[0];
    expect(update).not.toHaveProperty("consent_status");
    expect(result).toEqual({ ok: true, data: null });
  });

  it("[no opening_hours/address fields] this consent has nothing to do with the partner's public listing", () => {
    const acceptSignatureStart = source.indexOf("export async function acceptPartnerTransactionalConsent");
    const acceptSignature = source.slice(acceptSignatureStart, source.indexOf(")", acceptSignatureStart));
    expect(acceptSignature).not.toMatch(/openingHours/);
    expect(acceptSignature).not.toMatch(/address/);
  });

  it("[invalid or already-answered link] zero matching rows -> a clean error, never a throw", async () => {
    const client = fakeAdminClient(null);
    mockCreateAdminClient.mockReturnValue(client);
    const { acceptPartnerTransactionalConsent } = await import("./consentActions");

    const result = await acceptPartnerTransactionalConsent("stale-token");

    expect(result.ok).toBe(false);
  });

  it("[token of one type can never modify the other consent] acceptPartnerTransactionalConsent only ever writes whatsapp_* columns, acceptPartnerConsent only ever writes consent_* columns — verified structurally on both functions' own update payloads", async () => {
    const client1 = fakeAdminClient({ id: "partner-1" });
    mockCreateAdminClient.mockReturnValue(client1);
    const { acceptPartnerTransactionalConsent } = await import("./consentActions");
    await acceptPartnerTransactionalConsent("token-a");
    const [transactionalUpdate] = client1.update.mock.calls[0];
    expect(Object.keys(transactionalUpdate).every((key) => key.startsWith("whatsapp_consent_"))).toBe(true);

    const client2 = fakeAdminClient({ id: "partner-2" });
    mockCreateAdminClient.mockReturnValue(client2);
    const { acceptPartnerConsent } = await import("./consentActions");
    await acceptPartnerConsent("token-b");
    const [recommendationUpdate] = client2.update.mock.calls[0];
    expect(Object.keys(recommendationUpdate).some((key) => key.startsWith("whatsapp_consent_"))).toBe(false);
  });
});
