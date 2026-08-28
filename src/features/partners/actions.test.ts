import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "actions.ts"), "utf8");

/**
 * Chainable no-op stub covering every Supabase query shape used by this
 * file's internal helpers (insert().select().single(), update().eq().eq(),
 * delete().eq().eq()) — every method returns `this` except the terminal
 * ones, which resolve to a harmless { data: null, error: null }. Good
 * enough for these tests, which only assert on requireHotelAccess's own
 * call arguments, never on the DB write outcome itself.
 */
function fakeChainableSupabase() {
  const terminal = async () => ({ data: null, error: null });
  const chain: Record<string, unknown> = {
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    select: () => chain,
    eq: () => chain,
    single: terminal,
  };
  // delete()/update() resolve directly off .eq().eq() in this file (no
  // .single() call) — a plain (non-Promise) object awaits to itself, so
  // giving the chain its own { data, error } makes that destructure work.
  Object.assign(chain, { data: null, error: null });
  return { from: () => chain };
}

/** Same shape as fakeChainableSupabase(), but .delete().eq().eq() resolves with a PostgrestError-shaped { code, message } — used to simulate the 23503 FK violation from partner_requests_partner_fk (0020_partner_requests.sql) and other delete failures. */
function fakeChainableSupabaseWithDeleteError(code: string, message = "constraint violation detail") {
  const chain: Record<string, unknown> = {
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: null, error: null }),
  };
  Object.assign(chain, { data: null, error: { code, message } });
  return { from: () => chain };
}

const mockRequireHotelAccess = vi.fn<
  (hotelId: string, scope: string) => Promise<{ userId: string; profile: { id: string; role: string }; supabase: unknown }>
>(async () => ({
  userId: "user-1",
  profile: { id: "user-1", role: "superadmin" },
  supabase: fakeChainableSupabase(),
}));
vi.mock("@/lib/auth/session", () => ({
  requireHotelAccess: (hotelId: string, scope: string) => mockRequireHotelAccess(hotelId, scope),
}));

const mockSafeFetch = vi.fn();
vi.mock("@/features/crawler/networkGuard", () => ({
  safeFetch: (url: string) => mockSafeFetch(url),
}));

const mockExtractPage = vi.fn();
vi.mock("@/features/crawler/extract", () => ({
  extractPage: (html: string, url: string, langs: string[]) => mockExtractPage(html, url, langs),
}));

const mockResponsesCreate = vi.fn();
vi.mock("@/lib/openai/client", () => ({
  getOpenAIClient: () => ({ responses: { parse: (params: unknown) => mockResponsesCreate(params) } }),
}));
vi.mock("@/lib/openai/env", () => ({
  openaiChatModel: () => "gpt-test-model",
}));

const mockSendEmail = vi.fn<(params: unknown) => Promise<{ ok: true }>>(async () => ({ ok: true }));
vi.mock("@/lib/email/sendEmail", () => ({
  sendEmail: (params: unknown) => mockSendEmail(params),
}));

vi.mock("@/lib/http/currentOrigin", () => ({
  currentOrigin: async () => "https://app.example.com",
}));

afterEach(() => {
  mockRequireHotelAccess.mockClear();
  mockSafeFetch.mockReset();
  mockExtractPage.mockReset();
  mockResponsesCreate.mockReset();
  mockSendEmail.mockClear();
});

/**
 * Regression guards for the hotel_partners CRUD actions. `scope` is NEVER a
 * parameter of any EXPORTED function in this file — a client component
 * (PartnersManager.tsx/PartnerFormModal.tsx) must never be able to supply
 * or influence which cookie scope a shared action reads, even via a
 * tampered request payload. Every exported action is a thin,
 * hardcoded-scope wrapper around a non-exported `*Internal` function — see
 * actions.ts's own doc comment. Checked at the source level, same
 * constraint as every other Server Action in this repo (see
 * src/features/knowledge/actions.test.ts). requireHotelAccess itself
 * (superadmin-any-hotel vs hotel_admin-own-hotel-only) is already
 * exhaustively covered at runtime in src/lib/auth/session.test.ts — not
 * re-tested here.
 */
function sliceFunction(exportedName: string): string {
  const start = source.indexOf(`export async function ${exportedName}`);
  expect(start).toBeGreaterThan(-1);
  // Bounded by whichever comes first: the next exported wrapper, or the
  // next non-exported `*Internal` helper — an exported wrapper is always
  // immediately followed by one or the other, never by more of its own body.
  const nextExport = source.indexOf("\nexport async function", start + 1);
  const nextInternal = source.indexOf("\nasync function", start + 1);
  const boundaries = [nextExport, nextInternal].filter((i) => i !== -1);
  const end = boundaries.length > 0 ? Math.min(...boundaries) : undefined;
  return source.slice(start, end);
}

const EXPORTED_FUNCTION_NAMES = [
  "createHotelPartnerBackoffice",
  "createHotelPartnerClient",
  "updateHotelPartnerBackoffice",
  "updateHotelPartnerClient",
  "setHotelPartnerActiveBackoffice",
  "setHotelPartnerActiveClient",
  "deleteHotelPartnerBackoffice",
  "deleteHotelPartnerClient",
  "fetchPartnerWebsiteSummaryBackoffice",
  "fetchPartnerWebsiteSummaryClient",
  "requestPartnerConsentsBackoffice",
  "requestPartnerConsentsClient",
];

describe("no exported action ever accepts a scope parameter", () => {
  it("[signature audit] none of the exported functions declares a `scope` parameter — the whole point of the Backoffice/Client split", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      const fn = sliceFunction(name);
      const signatureEnd = fn.indexOf("Promise<");
      const signature = fn.slice(0, signatureEnd);
      expect(signature).not.toMatch(/scope/i);
    }
  });

  it("[no AuthScope import surfaces on an exported function] the only place AuthScope is used is the internal helpers' own parameter, never a public signature", () => {
    for (const name of EXPORTED_FUNCTION_NAMES) {
      expect(sliceFunction(name)).not.toMatch(/AuthScope/);
    }
  });
});

describe("toRow — request_phone_e164 mapped, never re-normalized here", () => {
  it("[mapped as-is] toRow passes through the schema's own already-validated/normalized value, no second transformation at the write layer", () => {
    const fn = source.slice(source.indexOf("function toRow"), source.indexOf("async function createHotelPartnerInternal"));
    expect(fn).toMatch(/request_phone_e164: input\.request_phone_e164,/);
  });

  it("[distinct from the public `phone` column] both fields are written independently, one is never derived from the other", () => {
    const fn = source.slice(source.indexOf("function toRow"), source.indexOf("async function createHotelPartnerInternal"));
    expect(fn).toMatch(/phone: input\.phone \|\| null,/);
    expect(fn).toMatch(/request_phone_e164: input\.request_phone_e164,/);
  });
});

describe("createHotelPartnerBackoffice / createHotelPartnerClient", () => {
  it("[hardcoded scope, no fallback] Backoffice always passes \"backoffice\", Client always passes \"client\" — never received from a caller", () => {
    expect(source).toMatch(/createHotelPartnerInternal\(hotelId, input, "backoffice"\)/);
    expect(source).toMatch(/createHotelPartnerInternal\(hotelId, input, "client"\)/);
  });

  // No real-invocation test here (unlike fetchPartnerWebsiteSummary* below):
  // createHotelPartnerInternal calls revalidatePath(), which throws
  // "Invariant: static generation store missing" outside a real Next.js
  // request context — the same reason every other revalidatePath-calling
  // action in this repo is checked at the source level only (see
  // src/features/knowledge/actions.test.ts). The "[hardcoded scope, no
  // fallback]" test above already proves — by reading the literal
  // "backoffice"/"client" string arguments in the source — that no
  // caller-supplied value can ever reach requireHotelAccess's scope
  // parameter for these two exports.

  it("[validated input] parses through hotelPartnerSchema before writing anything", () => {
    expect(sliceFunction("createHotelPartnerBackoffice")).toMatch(/createHotelPartnerInternal/);
    const internal = source.slice(source.indexOf("async function createHotelPartnerInternal"));
    expect(internal).toMatch(/hotelPartnerSchema\.safeParse\(input\)/);
  });

  it("[tenant isolation] the row is inserted with hotel_id — never a hotel_id implied by the input alone", () => {
    expect(source).toMatch(/hotel_id: hotelId/);
  });

  it("[session-bound client, not service_role] writes through the RLS-gated client requireHotelAccess resolves, never createAdminClient or a second, independently-scoped createClient() call", () => {
    expect(source).not.toMatch(/createAdminClient/);
    expect(source).not.toMatch(/from "@\/lib\/supabase\/server"/);
    expect(source).toMatch(/const \{ supabase \} = await requireHotelAccess\(hotelId, scope\)/);
  });
});

describe("updateHotelPartnerBackoffice / updateHotelPartnerClient", () => {
  it("[hardcoded scope, no fallback]", () => {
    expect(source).toMatch(/updateHotelPartnerInternal\(hotelId, partnerId, input, "backoffice"\)/);
    expect(source).toMatch(/updateHotelPartnerInternal\(hotelId, partnerId, input, "client"\)/);
  });

  it("[tenant isolation] scoped by BOTH partnerId and hotel_id — a guessed partnerId from another hotel can never be updated", () => {
    expect(source).toMatch(/\.eq\("id", partnerId\)\.eq\("hotel_id", hotelId\)/);
  });
});

describe("setHotelPartnerActiveBackoffice / setHotelPartnerActiveClient", () => {
  it("[hardcoded scope, no fallback]", () => {
    expect(source).toMatch(/setHotelPartnerActiveInternal\(hotelId, partnerId, isActive, "backoffice"\)/);
    expect(source).toMatch(/setHotelPartnerActiveInternal\(hotelId, partnerId, isActive, "client"\)/);
  });

  it("[narrow write] only is_active is written, never any other field", () => {
    expect(source).toMatch(/\.update\(\{ is_active: isActive \}\)/);
  });

  it("[tenant isolation]", () => {
    expect(source).toMatch(/\.eq\("id", partnerId\)\.eq\("hotel_id", hotelId\)/);
  });

  it("[unchanged by the delete/23503 correction] setHotelPartnerActiveInternal itself was not touched — it remains the functional alternative deleteHotelPartner's 23503 message now points hotel_admins to", () => {
    const fn = source.slice(source.indexOf("async function setHotelPartnerActiveInternal"), source.indexOf("export async function setHotelPartnerActiveBackoffice"));
    expect(fn).not.toMatch(/23503/);
    expect(fn).toMatch(/\.update\(\{ is_active: isActive \}\)/);
  });
});

/**
 * partner_requests_conversation_fk (0020_partner_requests.sql) protects
 * conversations the exact same way partner_requests_partner_fk protects
 * hotel_partners: no ON DELETE clause -> Postgres default NO ACTION -> a
 * conversation referenced by a partner_request could never be physically
 * deleted either. No conversation-delete action exists anywhere in this
 * codebase today (confirmed: no `.from("conversations").delete(` call), so
 * there is no code path to correct here — this note exists purely so a
 * future conversation-delete feature doesn't rediscover the same 23503 from
 * scratch; apply the identical error.code === "23503" handling there if one
 * is ever added.
 */
describe("deleteHotelPartnerBackoffice / deleteHotelPartnerClient", () => {
  it("[hardcoded scope, no fallback]", () => {
    expect(source).toMatch(/deleteHotelPartnerInternal\(hotelId, partnerId, "backoffice"\)/);
    expect(source).toMatch(/deleteHotelPartnerInternal\(hotelId, partnerId, "client"\)/);
  });

  it("[tenant isolation] delete is scoped by BOTH partnerId and hotel_id", () => {
    expect(source).toMatch(/\.delete\(\)\.eq\("id", partnerId\)\.eq\("hotel_id", hotelId\)/);
  });

  it("[no pre-check] never queries partner_requests before deleting — the FK is the only source of truth", () => {
    const fn = source.slice(source.indexOf("async function deleteHotelPartnerInternal"), source.indexOf("export async function deleteHotelPartnerBackoffice"));
    expect(fn).not.toMatch(/\.from\("partner_requests"\)/);
    expect(fn).not.toMatch(/\.select\(/);
  });

  it("[23503 — FK violation] a partner with existing partner_requests gets a specific, actionable message pointing to deactivation", async () => {
    const { deleteHotelPartnerBackoffice } = await import("./actions");
    mockRequireHotelAccess.mockResolvedValueOnce({
      userId: "user-1",
      profile: { id: "user-1", role: "superadmin" },
      supabase: fakeChainableSupabaseWithDeleteError("23503"),
    });

    const result = await deleteHotelPartnerBackoffice("hotel-a", "partner-1");

    expect(result).toEqual({
      ok: false,
      error: "Ce partenaire possède des demandes enregistrées et ne peut pas être supprimé. Désactivez-le à la place.",
    });
  });

  it("[other error codes] keep the existing generic message, unchanged", async () => {
    const { deleteHotelPartnerBackoffice } = await import("./actions");
    mockRequireHotelAccess.mockResolvedValueOnce({
      userId: "user-1",
      profile: { id: "user-1", role: "superadmin" },
      supabase: fakeChainableSupabaseWithDeleteError("42501"),
    });

    const result = await deleteHotelPartnerBackoffice("hotel-a", "partner-1");

    expect(result).toEqual({ ok: false, error: "Impossible de supprimer ce partenaire." });
  });

  it("[no raw SQL/detail exposed] the ActionResult never carries error.message or error.code, on either error path", async () => {
    const { deleteHotelPartnerBackoffice } = await import("./actions");

    mockRequireHotelAccess.mockResolvedValueOnce({
      userId: "user-1",
      profile: { id: "user-1", role: "superadmin" },
      supabase: fakeChainableSupabaseWithDeleteError("23503", "update or delete on table \"hotel_partners\" violates foreign key constraint"),
    });
    const fkResult = await deleteHotelPartnerBackoffice("hotel-a", "partner-1");
    expect(JSON.stringify(fkResult)).not.toMatch(/23503/);
    expect(JSON.stringify(fkResult)).not.toMatch(/violates foreign key/);

    mockRequireHotelAccess.mockResolvedValueOnce({
      userId: "user-1",
      profile: { id: "user-1", role: "superadmin" },
      supabase: fakeChainableSupabaseWithDeleteError("42501", "permission denied for table hotel_partners"),
    });
    const otherResult = await deleteHotelPartnerBackoffice("hotel-a", "partner-1");
    expect(JSON.stringify(otherResult)).not.toMatch(/42501/);
    expect(JSON.stringify(otherResult)).not.toMatch(/permission denied/);
  });

  it("[Backoffice/Client scope preserved on the error path too]", async () => {
    const { deleteHotelPartnerBackoffice, deleteHotelPartnerClient } = await import("./actions");

    mockRequireHotelAccess.mockResolvedValueOnce({
      userId: "user-1",
      profile: { id: "user-1", role: "superadmin" },
      supabase: fakeChainableSupabaseWithDeleteError("23503"),
    });
    await deleteHotelPartnerBackoffice("hotel-a", "partner-1");
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith("hotel-a", "backoffice");

    mockRequireHotelAccess.mockResolvedValueOnce({
      userId: "user-1",
      profile: { id: "user-1", role: "superadmin" },
      supabase: fakeChainableSupabaseWithDeleteError("23503"),
    });
    await deleteHotelPartnerClient("hotel-a", "partner-1");
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith("hotel-a", "client");
  });
});

describe("fetchPartnerWebsiteSummaryBackoffice / fetchPartnerWebsiteSummaryClient — real invocation (safeFetch/extractPage/OpenAI mocked, never a real network/API call)", () => {
  function extractedPage(overrides: Partial<{ title: string; metaDescription: string | null; text: string; likelyJsRendered: boolean }> = {}) {
    return {
      canonicalUrl: null,
      title: "Le Bistrot",
      metaDescription: "Restaurant traditionnel au centre-ville.",
      headings: [],
      text: "Le Bistrot propose une cuisine traditionnelle française depuis 1998, au coeur du centre-ville.",
      detectedLanguage: "fr",
      likelyJsRendered: false,
      images: [],
      guessedCapacity: null,
      ...overrides,
    };
  }

  it("[hardcoded scope, no fallback] each variant calls requireHotelAccess with its own hardcoded scope", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice, fetchPartnerWebsiteSummaryClient } = await import("./actions");
    mockSafeFetch.mockResolvedValue({ ok: false, errorReason: "network_unsafe" });

    await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith("hotel-a", "backoffice");

    await fetchPartnerWebsiteSummaryClient("hotel-a", "https://partner.example.com");
    expect(mockRequireHotelAccess).toHaveBeenLastCalledWith("hotel-a", "client");
  });

  it("[both roles authorized] guarded by requireHotelAccess, same as every other action here", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockRequireHotelAccess.mockRejectedValueOnce(new Error("not authorized"));

    await expect(fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com")).rejects.toThrow();
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("[invalid URL] rejected before any network call — javascript:/data: URLs never reach safeFetch", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "javascript:alert(1)");

    expect(result.ok).toBe(false);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("[safeFetch failure] SSRF/network/timeout failures produce a clean ActionResult, never a raw throw", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: false, errorReason: "network_unsafe" });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(false);
    expect(mockExtractPage).not.toHaveBeenCalled();
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  it("[too little text] a page with almost no extracted text is rejected before calling OpenAI", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html></html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage({ title: "", metaDescription: null, text: "" }));

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(false);
    expect(mockResponsesCreate).not.toHaveBeenCalled();
  });

  it("[likely JS-rendered, no text] gets a distinguishable, more helpful error than the generic 'not enough text' one", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html></html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage({ title: "", metaDescription: null, text: "", likelyJsRendered: true }));

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/JavaScript/);
  });

  it("[success] extracted text is sent to OpenAI, the generated description is returned", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html>...</html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({
      output_parsed: { description: "Restaurant traditionnel français au centre-ville, ouvert depuis 1998.", address: null, openingHours: null },
    });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result).toEqual({
      ok: true,
      data: { description: "Restaurant traditionnel français au centre-ville, ouvert depuis 1998.", address: null, openingHours: null },
    });
    expect(mockResponsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-test-model", input: expect.stringContaining("Le Bistrot") })
    );
  });

  it("[opening hours found] extracted verbatim from the site's own text, capped at the same length as the DB constraint", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html>...</html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({
      output_parsed: { description: "Un restaurant.", address: null, openingHours: "Lun-Sam 12h-14h, 19h-22h" },
    });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result).toEqual({ ok: true, data: { description: "Un restaurant.", address: null, openingHours: "Lun-Sam 12h-14h, 19h-22h" } });
  });

  it("[opening hours not found on the site] null, never guessed", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html>...</html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({ output_parsed: { description: "Un restaurant.", address: null, openingHours: null } });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(true);
    expect(result.data?.openingHours).toBeNull();
  });

  it("[address found] extracted verbatim from the site's own text", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html>...</html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({
      output_parsed: { description: "Un restaurant.", address: "8 Rue Talairat, 12400 Saint-Affrique", openingHours: null },
    });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.data?.address).toBe("8 Rue Talairat, 12400 Saint-Affrique");
  });

  it("[address not found on the site] null, never guessed from the name/domain", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html>...</html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({ output_parsed: { description: "Un restaurant.", address: null, openingHours: null } });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(true);
    expect(result.data?.address).toBeNull();
  });

  it("[no structured output parsed] a clean ActionResult, never a raw throw", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html>...</html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({ output_parsed: null });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(false);
  });

  it("[never invents facts — instructions forbid it] the model is explicitly told never to invent hours/prices/reviews or unjustified superlatives", async () => {
    const { fetchPartnerWebsiteSummaryClient } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html></html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({ output_text: "Une description." });

    await fetchPartnerWebsiteSummaryClient("hotel-a", "https://partner.example.com");

    const [params] = mockResponsesCreate.mock.calls[0];
    expect(params.instructions).toMatch(/N'invente RIEN/);
    expect(params.instructions).toMatch(/superlatif marketing/);
  });

  it("[OpenAI failure] resolves a clean ActionResult, never a raw throw, no secret leaked", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html></html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockRejectedValueOnce(new Error("OpenAI API error"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(false);

    vi.restoreAllMocks();
  });

  it("[description length bounded] a very long model output is truncated, never saved unbounded", async () => {
    const { fetchPartnerWebsiteSummaryBackoffice } = await import("./actions");
    mockSafeFetch.mockResolvedValueOnce({ ok: true, body: "<html></html>", finalUrl: "https://partner.example.com" });
    mockExtractPage.mockReturnValueOnce(extractedPage());
    mockResponsesCreate.mockResolvedValueOnce({ output_parsed: { description: "x".repeat(2000), openingHours: null } });

    const result = await fetchPartnerWebsiteSummaryBackoffice("hotel-a", "https://partner.example.com");

    expect(result.ok).toBe(true);
    expect(result.data?.description.length).toBeLessThanOrEqual(500);
  });

  it("[never touches accommodation/RAG tables] no reference anywhere in this function to knowledge_sources/knowledge_chunks/accommodation_types", () => {
    const fn = source.slice(source.indexOf("async function fetchPartnerWebsiteSummaryInternal"));
    expect(fn).not.toMatch(/knowledge_sources|knowledge_chunks|accommodation_types/);
  });
});

/**
 * requestPartnerConsentsBackoffice/Client — the SINGLE unified send action
 * covering BOTH independent consents (recommendation + WhatsApp) in one
 * email/one token. Like every other write in this file, checked at the
 * source level only: requestPartnerConsentsInternal calls revalidatePath()
 * (via revalidatePartnerPaths), which throws "Invariant: static generation
 * store missing" outside a real Next.js request context.
 */
describe("requestPartnerConsentsBackoffice / requestPartnerConsentsClient", () => {
  function internalSource() {
    const start = source.indexOf("async function requestPartnerConsentsInternal");
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("export async function requestPartnerConsentsBackoffice"));
  }

  it("[hardcoded scope, no fallback] Backoffice always passes \"backoffice\", Client always passes \"client\" — never received from a caller", () => {
    expect(source).toMatch(/requestPartnerConsentsInternal\(hotelId, partnerId, "backoffice"\)/);
    expect(source).toMatch(/requestPartnerConsentsInternal\(hotelId, partnerId, "client"\)/);
  });

  it("[session-bound client, not service_role] writes through the RLS-gated client requireHotelAccess resolves", () => {
    const fn = internalSource();
    expect(fn).toMatch(/const \{ supabase \} = await requireHotelAccess\(hotelId, scope\)/);
    expect(fn).not.toMatch(/createAdminClient/);
  });

  it("[no email set] rejected BEFORE any eligibility check, any token is generated, or any email sent", () => {
    const fn = internalSource();
    const emailCheckIndex = fn.indexOf("if (!partner.email)");
    const eligibilityIndex = fn.indexOf("isRecommendationEligible");
    const tokenIndex = fn.indexOf("generateConsentToken()");
    const sendIndex = fn.indexOf("sendEmail(");
    expect(emailCheckIndex).toBeGreaterThan(-1);
    expect(emailCheckIndex).toBeLessThan(eligibilityIndex);
    expect(emailCheckIndex).toBeLessThan(tokenIndex);
    expect(emailCheckIndex).toBeLessThan(sendIndex);
  });

  it("[single email, single template] exactly one sendEmail call, using the SAME partnerConsentTemplate for both consents — no second template/channel", () => {
    const fn = internalSource();
    expect(fn.match(/sendEmail\(/g)?.length).toBe(1);
    expect(fn.match(/partnerConsentTemplate\(/g)?.length).toBe(1);
    expect(fn).not.toMatch(/partnerTransactionalConsentTemplate/);
    expect(fn).not.toMatch(/twilio|meta\.com|webhook/i);
  });

  it("[single token, single link] exactly one generateConsentToken() call, one consentUrl, never a &type= parameter", () => {
    const fn = internalSource();
    expect(fn.match(/generateConsentToken\(\)/g)?.length).toBe(1);
    expect(fn.match(/const consentUrl/g)?.length).toBe(1);
    expect(fn).not.toMatch(/&type=/);
  });

  it("[eligibility] recommendation eligible unless already \"accepted\"; WhatsApp eligible only with request_phone_e164 set AND not already \"accepted\"", () => {
    const fn = internalSource();
    expect(fn).toMatch(/isRecommendationEligible = partner\.consent_status !== "accepted"/);
    expect(fn).toMatch(/isWhatsappEligible = Boolean\(partner\.request_phone_e164\) && partner\.whatsapp_consent_status !== "accepted"/);
  });

  it("[nothing eligible] neither consent eligible -> a clean error, no token generated, no email sent", () => {
    const fn = internalSource();
    const guardIndex = fn.indexOf("if (!isRecommendationEligible && !isWhatsappEligible)");
    const tokenIndex = fn.indexOf("generateConsentToken()");
    const sendIndex = fn.indexOf("sendEmail(");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(tokenIndex);
    expect(guardIndex).toBeLessThan(sendIndex);
  });

  it("[never re-requests an already-accepted consent] an \"accepted\" status is never included in the eligibility check as still-eligible", () => {
    const fn = internalSource();
    expect(fn).not.toMatch(/consent_status\s*===\s*"accepted"/); // only the negated form (!==) drives eligibility, never a positive re-request-if-accepted branch
  });

  it("[tenant isolation] both the partner lookup and the status update are scoped by BOTH id and hotel_id", () => {
    const fn = internalSource();
    expect(fn).toMatch(/\.eq\("id", partnerId\)\s*\n?\s*\.eq\("hotel_id", hotelId\)/);
    expect(fn.match(/\.eq\("hotel_id", hotelId\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("[token never persisted in plaintext] only tokenHash is written to either row, the raw token exists solely inside the built URL", () => {
    const fn = internalSource();
    expect(fn).toMatch(/consent_token_hash: tokenHash/);
    expect(fn).toMatch(/whatsapp_consent_token_hash: tokenHash/);
    expect(fn).not.toMatch(/consent_token_hash:\s*token[^H]/);
  });

  it("[never logs the token] no console call anywhere in this function includes the raw token/consentUrl", () => {
    const fn = internalSource();
    const logCalls = fn.match(/console\.error\([^)]*\)/g) ?? [];
    for (const call of logCalls) {
      expect(call).not.toMatch(/\btoken\b/);
      expect(call).not.toMatch(/consentUrl/);
    }
  });

  it("[blocking gate, independent columns] sets consent_status/whatsapp_consent_status to \"pending\" ONLY for the eligible one(s) — the two update fragments are conditionally spread, never unconditional", () => {
    const fn = internalSource();
    expect(fn).toMatch(/isRecommendationEligible \? \{ consent_status: "pending"/);
    expect(fn).toMatch(/isWhatsappEligible\s*\n?\s*\? \{ whatsapp_consent_status: "pending"/);
  });
});
