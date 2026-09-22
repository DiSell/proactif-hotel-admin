import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "targetedImport.ts"), "utf8");

const TEST_HOTEL_ID = "hotel-test-1837";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("./targetedImportPlan", () => ({
  LE_1837_HOTEL_ID: TEST_HOTEL_ID,
  TARGETED_HOTEL_MEDIA_IMPORT_PLAN: [
    {
      category: "pool",
      title: null,
      sourceUrl: "https://example.test/pool",
      imageUrls: ["https://example.test/pool-1.jpg"],
    },
    {
      category: "spa",
      title: null,
      sourceUrl: "https://example.test/spa",
      imageUrls: ["https://example.test/spa-1.jpg", "https://example.test/spa-2.jpg"],
    },
  ],
}));

const mockRequireSuperadmin = vi.fn<() => Promise<{ userId: string; profile: { id: string; role: string } }>>(
  async () => ({ userId: "superadmin-1", profile: { id: "superadmin-1", role: "superadmin" } })
);
vi.mock("@/lib/auth/session", () => ({
  requireSuperadmin: () => mockRequireSuperadmin(),
}));

const mockSafeFetchBinary = vi.fn();
vi.mock("@/features/crawler/networkGuard", () => ({
  safeFetchBinary: (url: string) => mockSafeFetchBinary(url),
}));

const mockCreateClient = vi.fn<() => Promise<SupabaseClient>>();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
}));

afterEach(() => {
  mockRequireSuperadmin.mockClear();
  mockSafeFetchBinary.mockReset();
  mockCreateClient.mockReset();
});

function fetchedOk(contentHash: string, contentType = "image/jpeg") {
  return { ok: true, body: Buffer.from("fake"), contentHash, contentType };
}

/**
 * hotel_media table double: keyed by content_hash so the pre-insert dedup
 * check can actually find (or not find) a row, exactly like the real
 * `.select("id").eq("hotel_id", ...).eq("content_hash", ...).maybeSingle()`
 * call. `existingHashes` seeds what a re-run should already see as
 * duplicate; inserts push into it so a second loop iteration within the
 * SAME test run is caught too (real idempotency within one invocation, not
 * just across invocations).
 */
function fakeSupabase(opts: { existingHashes?: Set<string>; existingCountByCategory?: Record<string, number>; uploadFails?: boolean; insertFails?: boolean } = {}) {
  const existingHashes = opts.existingHashes ?? new Set<string>();
  const existingCountByCategory = opts.existingCountByCategory ?? {};
  const inserted: Record<string, unknown>[] = [];

  const client = {
    from: (table: string) => {
      if (table !== "hotel_media") throw new Error(`unexpected table ${table}`);
      let mode: "count" | "dedup" | null = null;
      let category: string | undefined;
      let contentHash: string | undefined;
      const chain = {
        select: (_cols: string, opts2?: { count?: string; head?: boolean }) => {
          mode = opts2?.count ? "count" : "dedup";
          return chain;
        },
        eq: (col: string, value: string) => {
          if (col === "category") category = value;
          if (col === "content_hash") contentHash = value;
          return chain;
        },
        maybeSingle: async () => ({ data: contentHash && existingHashes.has(contentHash) ? { id: `existing-${contentHash}` } : null, error: null }),
        then: (onFulfilled: (v: unknown) => unknown) => {
          if (mode === "count") {
            return Promise.resolve({ count: existingCountByCategory[category ?? ""] ?? 0 }).then(onFulfilled);
          }
          return Promise.resolve({ data: null, error: null }).then(onFulfilled);
        },
        insert: (row: Record<string, unknown>) => ({
          then: (onFulfilled: (v: unknown) => unknown) => {
            if (opts.insertFails) return Promise.resolve({ error: { message: "insert failed" } }).then(onFulfilled);
            existingHashes.add(row.content_hash as string);
            inserted.push(row);
            return Promise.resolve({ error: null }).then(onFulfilled);
          },
        }),
      };
      return chain;
    },
    storage: {
      from: () => ({
        upload: async () => (opts.uploadFails ? { error: { message: "upload failed" } } : { error: null }),
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://storage.example.com/hotel-media/${path}` } }),
      }),
    },
  };

  return { client: client as unknown as SupabaseClient, inserted };
}

describe("importTargetedHotelMedia — authorization model", () => {
  it("[requireSuperadmin] always called before anything else", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client } = fakeSupabase();
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockResolvedValue(fetchedOk("h1"));

    await importTargetedHotelMedia(TEST_HOTEL_ID);
    expect(mockRequireSuperadmin).toHaveBeenCalledTimes(1);
  });

  it("[hotel-scoped] refuses any hotelId other than the one this plan targets, before touching Supabase at all", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const result = await importTargetedHotelMedia("some-other-hotel");
    expect(result.ok).toBe(false);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockSafeFetchBinary).not.toHaveBeenCalled();
  });

  it("[no service_role writer] never imports createAdminClient — only the session-bound createClient()", () => {
    expect(source).not.toMatch(/import.*createAdminClient/);
    expect(source).not.toMatch(/@\/lib\/supabase\/admin/);
    expect(source).toMatch(/import \{ createClient \} from "@\/lib\/supabase\/server";/);
  });

  it("[safeFetchBinary reused as-is, never reimplemented] no second fetch/hash implementation in this file", () => {
    expect(source).toMatch(/import \{ safeFetchBinary \} from "@\/features\/crawler\/networkGuard";/);
    expect(source).not.toMatch(/createHash\(/);
    expect(source).not.toMatch(/fetch\(/);
  });
});

describe("importTargetedHotelMedia — real invocation", () => {
  it("[success] downloads, uploads, inserts each image, category and is_selected/position set correctly", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client, inserted } = fakeSupabase();
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) => fetchedOk(`hash-${url}`));

    const result = await importTargetedHotelMedia(TEST_HOTEL_ID);

    expect(result).toEqual({ ok: true, data: { photosImported: 3, photosSkippedDuplicate: 0, photosFailed: 0 } });
    expect(inserted).toHaveLength(3);
    expect(inserted.find((r) => r.category === "pool")).toMatchObject({ is_selected: true, position: 0, hotel_id: TEST_HOTEL_ID });
    const spaRows = inserted.filter((r) => r.category === "spa");
    expect(spaRows.map((r) => r.position)).toEqual([0, 1]);
    expect(spaRows.every((r) => r.is_selected === true)).toBe(true);
  });

  it("[Storage path pattern] {hotel_id}/{uuid}.{ext}, ext derived from the real content type", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client, inserted } = fakeSupabase();
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) => fetchedOk(`hash-${url}`, "image/png"));

    await importTargetedHotelMedia(TEST_HOTEL_ID);

    for (const row of inserted) {
      expect(row.storage_path).toMatch(
        new RegExp(`^${TEST_HOTEL_ID}/[0-9a-f-]{36}\\.png$`)
      );
    }
  });

  it("[dedup by content_hash] a hash already present in hotel_media for this hotel is skipped — never uploaded, never inserted again", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client, inserted } = fakeSupabase({ existingHashes: new Set(["hash-https://example.test/pool-1.jpg"]) });
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) => fetchedOk(`hash-${url}`));

    const result = await importTargetedHotelMedia(TEST_HOTEL_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ photosImported: 2, photosSkippedDuplicate: 1, photosFailed: 0 });
    }
    expect(inserted.some((r) => r.category === "pool")).toBe(false);
  });

  it("[idempotent re-run] running the import twice never recreates already-imported photos the second time", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client } = fakeSupabase();
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) => fetchedOk(`hash-${url}`));

    const first = await importTargetedHotelMedia(TEST_HOTEL_ID);
    const second = await importTargetedHotelMedia(TEST_HOTEL_ID);

    expect(first.ok && first.data).toEqual({ photosImported: 3, photosSkippedDuplicate: 0, photosFailed: 0 });
    expect(second.ok && second.data).toEqual({ photosImported: 0, photosSkippedDuplicate: 3, photosFailed: 0 });
  });

  it("[position continues from existing count] a category that already has photos in hotel_media gets new positions appended, never restarting at 0", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client, inserted } = fakeSupabase({ existingCountByCategory: { pool: 5 } });
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) => fetchedOk(`hash-${url}`));

    await importTargetedHotelMedia(TEST_HOTEL_ID);

    const poolRow = inserted.find((r) => r.category === "pool");
    expect(poolRow?.position).toBe(5);
  });

  it("[download failure -> counted as failed, never throws, never blocks the rest of the plan]", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client } = fakeSupabase();
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) =>
      url.includes("pool") ? { ok: false, errorReason: "http_error" } : fetchedOk(`hash-${url}`)
    );

    const result = await importTargetedHotelMedia(TEST_HOTEL_ID);
    expect(result.ok && result.data).toEqual({ photosImported: 2, photosSkippedDuplicate: 0, photosFailed: 1 });
  });

  it("[upload failure -> counted as failed]", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client } = fakeSupabase({ uploadFails: true });
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) => fetchedOk(`hash-${url}`));

    const result = await importTargetedHotelMedia(TEST_HOTEL_ID);
    expect(result.ok && result.data).toEqual({ photosImported: 0, photosSkippedDuplicate: 0, photosFailed: 3 });
  });

  it("[insert failure -> counted as failed]", async () => {
    const { importTargetedHotelMedia } = await import("./targetedImport");
    const { client } = fakeSupabase({ insertFails: true });
    mockCreateClient.mockResolvedValue(client);
    mockSafeFetchBinary.mockImplementation(async (url: string) => fetchedOk(`hash-${url}`));

    const result = await importTargetedHotelMedia(TEST_HOTEL_ID);
    expect(result.ok && result.data).toEqual({ photosImported: 0, photosSkippedDuplicate: 0, photosFailed: 3 });
  });
});

describe("importTargetedHotelMedia — aucune régression room_photos/accommodation_types", () => {
  it("[ce fichier n'écrit jamais dans room_photos/accommodation_types, ni n'appelle saveAccommodationTypes — une mention en commentaire expliquant la non-interférence est acceptée]", () => {
    expect(source).not.toMatch(/\.from\("room_photos"\)/);
    expect(source).not.toMatch(/\.from\("accommodation_types"\)/);
    expect(source).not.toMatch(/saveAccommodationTypes\(/);
    expect(source).not.toMatch(/@\/features\/knowledge\/actions/);
  });
});
