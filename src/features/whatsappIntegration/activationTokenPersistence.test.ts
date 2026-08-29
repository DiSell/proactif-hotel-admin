import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A minimal, STATEFUL fake of the one Postgres table this module touches —
 * not a "was this method called" mock. The concurrency guarantees this
 * task cares about (claim/release/mark-used atomicity, expiry/revocation/
 * used-once enforcement) are properties of the actual WHERE-clause
 * predicates the code builds, so they're exercised here against real
 * filter evaluation (eq/is/gt/or), not asserted by inspecting call
 * arguments. Real end-to-end atomicity (that Postgres itself serializes
 * two concurrent UPDATE statements on the same row) is a Postgres
 * guarantee this test cannot exercise — what IS verified here is that the
 * application code issues the correct single-statement, correctly-scoped
 * UPDATE that WOULD be atomic against a real database.
 */
const { tableState } = vi.hoisted(() => ({ tableState: { rows: [] as Record<string, unknown>[], nextId: 1 } }));

function resetTable(rows: Record<string, unknown>[] = []) {
  tableState.rows = rows.map((r) => ({ ...r }));
  tableState.nextId = tableState.rows.length + 1;
}

function matchesFilter(row: Record<string, unknown>, filter: { type: string; col?: string; val?: unknown; orExpr?: string }): boolean {
  if (filter.type === "eq") return row[filter.col!] === filter.val;
  if (filter.type === "is") return (row[filter.col!] ?? null) === filter.val;
  if (filter.type === "gt") return typeof row[filter.col!] === "string" && (row[filter.col!] as string) > (filter.val as string);
  if (filter.type === "or") {
    return filter.orExpr!.split(",").some((cond) => {
      const [col, op, val] = cond.split(".");
      if (op === "is" && val === "null") return (row[col] ?? null) === null;
      if (op === "lt") return typeof row[col] === "string" && (row[col] as string) < val;
      return false;
    });
  }
  return true;
}

function makeFakeAdminClient() {
  return {
    from() {
      const filters: Array<{ type: string; col?: string; val?: unknown; orExpr?: string }> = [];
      let mode: "read" | "update" | "insert" = "read";
      let patch: Record<string, unknown> | null = null;
      let insertRow: Record<string, unknown> | null = null;
      let orderCol: string | null = null;
      let orderDesc = false;
      let limitN: number | null = null;

      function execute(): { data: unknown; error: null } {
        if (mode === "insert" && insertRow) {
          const row = { id: `row-${tableState.nextId++}`, processing_started_at: null, used_at: null, revoked_at: null, ...insertRow };
          tableState.rows.push(row);
          return { data: null, error: null };
        }

        let matched = tableState.rows.filter((r) => filters.every((f) => matchesFilter(r, f)));
        if (orderCol) {
          const col = orderCol;
          matched = [...matched].sort((a, b) => ((a[col] as string) < (b[col] as string) ? (orderDesc ? 1 : -1) : orderDesc ? -1 : 1));
        }
        if (limitN != null) matched = matched.slice(0, limitN);

        if (mode === "update" && patch) {
          matched.forEach((r) => Object.assign(r, patch));
        }

        return { data: matched[0] ?? null, error: null };
      }

      const api = {
        eq(col: string, val: unknown) {
          filters.push({ type: "eq", col, val });
          return api;
        },
        is(col: string, val: unknown) {
          filters.push({ type: "is", col, val });
          return api;
        },
        gt(col: string, val: unknown) {
          filters.push({ type: "gt", col, val });
          return api;
        },
        or(expr: string) {
          filters.push({ type: "or", orExpr: expr });
          return api;
        },
        order(col: string, opts?: { ascending?: boolean }) {
          orderCol = col;
          orderDesc = opts?.ascending === false;
          return api;
        },
        limit(n: number) {
          limitN = n;
          return api;
        },
        select() {
          return api;
        },
        insert(row: Record<string, unknown>) {
          mode = "insert";
          insertRow = row;
          return Promise.resolve(execute());
        },
        update(p: Record<string, unknown>) {
          mode = "update";
          patch = p;
          return api;
        },
        maybeSingle() {
          return Promise.resolve(execute());
        },
        then(resolve: (value: { data: unknown; error: null }) => void, reject: (reason: unknown) => void) {
          return Promise.resolve(execute()).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => makeFakeAdminClient(),
}));
vi.mock("@/lib/http/currentOrigin", () => ({
  currentOrigin: async () => "https://app.example.test",
}));

afterEach(() => {
  resetTable();
  vi.resetModules();
});

const HOTEL_ID = "hotel-a";
const OTHER_HOTEL_ID = "hotel-b";

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}
function pastIso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

describe("createActivationLink", () => {
  it("[creates a link] returns a URL containing the raw token and the correct expiry, and inserts exactly one new row", async () => {
    resetTable();
    const { createActivationLink } = await import("./activationTokenPersistence");

    const result = await createActivationLink(HOTEL_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.url).toMatch(/^https:\/\/app\.example\.test\/whatsapp\/connect\/[0-9a-f]{64}$/);
    expect(tableState.rows).toHaveLength(1);
    expect(tableState.rows[0].hotel_id).toBe(HOTEL_ID);
    expect(tableState.rows[0].expires_at).toBe(result.data.expiresAt);
  });

  it("[raw token never persisted] only its sha256 hash is stored, and it is 64 hex characters (0029's own CHECK constraint)", async () => {
    resetTable();
    const { createActivationLink } = await import("./activationTokenPersistence");

    const result = await createActivationLink(HOTEL_ID);
    if (!result.ok) throw new Error("unreachable");
    const rawToken = result.data.url.split("/").pop()!;

    expect(tableState.rows[0].token_hash).not.toBe(rawToken);
    expect(tableState.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[9 — régénération] generating a second link for the same hotel revokes the first still-active one, leaving at most one active link", async () => {
    resetTable([{ id: "old", hotel_id: HOTEL_ID, token_hash: "a".repeat(64), expires_at: futureIso(1000), used_at: null, revoked_at: null }]);
    const { createActivationLink } = await import("./activationTokenPersistence");

    await createActivationLink(HOTEL_ID);

    const oldRow = tableState.rows.find((r) => r.id === "old")!;
    expect(oldRow.revoked_at).not.toBeNull();
    const activeRows = tableState.rows.filter((r) => !r.used_at && !r.revoked_at);
    expect(activeRows).toHaveLength(1);
  });

  it("[régénération never touches a used connection's token] a token that already has used_at set is left untouched", async () => {
    const usedAt = pastIso(1000);
    resetTable([{ id: "used-1", hotel_id: HOTEL_ID, token_hash: "b".repeat(64), expires_at: futureIso(1000), used_at: usedAt, revoked_at: null }]);
    const { createActivationLink } = await import("./activationTokenPersistence");

    await createActivationLink(HOTEL_ID);

    const usedRow = tableState.rows.find((r) => r.id === "used-1")!;
    expect(usedRow.revoked_at).toBeNull();
    expect(usedRow.used_at).toBe(usedAt);
  });

  it("[tenant isolation] regenerating a link for one hotel never revokes another hotel's active token", async () => {
    resetTable([{ id: "other", hotel_id: OTHER_HOTEL_ID, token_hash: "c".repeat(64), expires_at: futureIso(1000), used_at: null, revoked_at: null }]);
    const { createActivationLink } = await import("./activationTokenPersistence");

    await createActivationLink(HOTEL_ID);

    const otherRow = tableState.rows.find((r) => r.id === "other")!;
    expect(otherRow.revoked_at).toBeNull();
  });

  it("[regeneration refused while genuinely in progress] a token with a FRESH lease (<10 min) is never revoked, and regeneration is cleanly refused rather than creating a second active token", async () => {
    resetTable([
      {
        id: "in-progress",
        hotel_id: HOTEL_ID,
        token_hash: "k".repeat(64),
        expires_at: futureIso(60_000),
        used_at: null,
        revoked_at: null,
        processing_started_at: pastIso(60 * 1000),
      },
    ]);
    const { createActivationLink } = await import("./activationTokenPersistence");

    const result = await createActivationLink(HOTEL_ID);

    expect(result).toEqual({ ok: false, errorCode: "activation_in_progress" });
    const row = tableState.rows.find((r) => r.id === "in-progress")!;
    expect(row.revoked_at).toBeNull();
    expect(tableState.rows).toHaveLength(1); // no second token was inserted
  });

  it("[regeneration allowed once the lease is stale (>10 min, abandoned/crashed)] the stale token is revoked and a fresh one created", async () => {
    resetTable([
      {
        id: "stale-lease",
        hotel_id: HOTEL_ID,
        token_hash: "l".repeat(64),
        expires_at: futureIso(60_000),
        used_at: null,
        revoked_at: null,
        processing_started_at: pastIso(11 * 60 * 1000),
      },
    ]);
    const { createActivationLink } = await import("./activationTokenPersistence");

    const result = await createActivationLink(HOTEL_ID);

    expect(result.ok).toBe(true);
    const oldRow = tableState.rows.find((r) => r.id === "stale-lease")!;
    expect(oldRow.revoked_at).not.toBeNull();
    const activeRows = tableState.rows.filter((r) => !r.used_at && !r.revoked_at);
    expect(activeRows).toHaveLength(1);
  });

  it("[regeneration allowed when no lease was ever held] unchanged behavior for a plain never-claimed token", async () => {
    resetTable([{ id: "no-lease", hotel_id: HOTEL_ID, token_hash: "m".repeat(64), expires_at: futureIso(60_000), used_at: null, revoked_at: null, processing_started_at: null }]);
    const { createActivationLink } = await import("./activationTokenPersistence");

    const result = await createActivationLink(HOTEL_ID);

    expect(result.ok).toBe(true);
    const oldRow = tableState.rows.find((r) => r.id === "no-lease")!;
    expect(oldRow.revoked_at).not.toBeNull();
  });
});

describe("peekActivationTokenStatus — read-only, never mutates", () => {
  it("[valid] a fresh, unused, unrevoked token is valid", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: futureIso(60_000), used_at: null, revoked_at: null }]);
    const { peekActivationTokenStatus } = await import("./activationTokenPersistence");

    expect(await peekActivationTokenStatus(token)).toBe("valid");
    // Read-only: the row must be untouched.
    expect(tableState.rows[0].used_at).toBeNull();
    expect(tableState.rows[0].revoked_at).toBeNull();
  });

  it("[unknown token] invalid, same generic result as every other invalid case", async () => {
    resetTable();
    const { peekActivationTokenStatus } = await import("./activationTokenPersistence");
    expect(await peekActivationTokenStatus("does-not-exist")).toBe("invalid");
  });

  it("[expired] invalid", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: pastIso(1000), used_at: null, revoked_at: null }]);
    const { peekActivationTokenStatus } = await import("./activationTokenPersistence");
    expect(await peekActivationTokenStatus(token)).toBe("invalid");
  });

  it("[revoked] invalid", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: futureIso(60_000), used_at: null, revoked_at: pastIso(1000) }]);
    const { peekActivationTokenStatus } = await import("./activationTokenPersistence");
    expect(await peekActivationTokenStatus(token)).toBe("invalid");
  });

  it("[used] invalid", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: futureIso(60_000), used_at: pastIso(1000), revoked_at: null }]);
    const { peekActivationTokenStatus } = await import("./activationTokenPersistence");
    expect(await peekActivationTokenStatus(token)).toBe("invalid");
  });
});

describe("claimActivationToken — single atomic UPDATE ... RETURNING, no prior SELECT", () => {
  it("[5] never issues a SELECT before the claiming UPDATE — the module has no separate read step for this operation", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "activationTokenPersistence.ts"), "utf8");
    const fnStart = source.indexOf("export async function claimActivationToken");
    const fnEnd = source.indexOf("\nexport ", fnStart + 1);
    const fn = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    // Exactly one query is built in this function: the update chain itself.
    expect(fn.match(/supabase\s*\n?\s*\.from\(/g)?.length).toBe(1);
    expect(fn).toMatch(/\.update\(\{ processing_started_at: nowIso \}\)/);
  });

  it("[claim succeeds] a fresh token is claimed and its hotelId/tokenId are returned; processing_started_at is set", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: futureIso(60_000), used_at: null, revoked_at: null }]);
    const { claimActivationToken } = await import("./activationTokenPersistence");

    const result = await claimActivationToken(token);

    expect(result).toEqual({ ok: true, data: { tokenId: "row-1", hotelId: HOTEL_ID } });
    expect(tableState.rows[0].processing_started_at).not.toBeNull();
  });

  it("[10 — two concurrent claims, one wins] the second claim attempt on the same already-claimed token fails", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: futureIso(60_000), used_at: null, revoked_at: null }]);
    const { claimActivationToken } = await import("./activationTokenPersistence");

    const first = await claimActivationToken(token);
    const second = await claimActivationToken(token);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false });
  });

  it("[token used] cannot be reclaimed", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: futureIso(60_000), used_at: pastIso(1000), revoked_at: null }]);
    const { claimActivationToken } = await import("./activationTokenPersistence");

    expect(await claimActivationToken(token)).toEqual({ ok: false });
  });

  it("[token revoked] cannot be reclaimed", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: futureIso(60_000), used_at: null, revoked_at: pastIso(1000) }]);
    const { claimActivationToken } = await import("./activationTokenPersistence");

    expect(await claimActivationToken(token)).toEqual({ ok: false });
  });

  it("[token expired] cannot be claimed", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: tokenHash, expires_at: pastIso(1000), used_at: null, revoked_at: null }]);
    const { claimActivationToken } = await import("./activationTokenPersistence");

    expect(await claimActivationToken(token)).toEqual({ ok: false });
  });

  it("[unknown token] cannot be claimed", async () => {
    resetTable();
    const { claimActivationToken } = await import("./activationTokenPersistence");
    expect(await claimActivationToken("unknown-raw-token")).toEqual({ ok: false });
  });

  it("[11 — crash recovery] a lease older than 10 minutes is treated as abandoned and can be reclaimed", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([
      {
        id: "row-1",
        hotel_id: HOTEL_ID,
        token_hash: tokenHash,
        expires_at: futureIso(60_000),
        used_at: null,
        revoked_at: null,
        processing_started_at: pastIso(11 * 60 * 1000),
      },
    ]);
    const { claimActivationToken } = await import("./activationTokenPersistence");

    const result = await claimActivationToken(token);
    expect(result).toEqual({ ok: true, data: { tokenId: "row-1", hotelId: HOTEL_ID } });
  });

  it("[fresh lease, under 10 minutes] cannot be reclaimed while genuinely in progress", async () => {
    const { generateActivationToken } = await import("./activationToken");
    const { token, tokenHash } = generateActivationToken();
    resetTable([
      {
        id: "row-1",
        hotel_id: HOTEL_ID,
        token_hash: tokenHash,
        expires_at: futureIso(60_000),
        used_at: null,
        revoked_at: null,
        processing_started_at: pastIso(60 * 1000),
      },
    ]);
    const { claimActivationToken } = await import("./activationTokenPersistence");

    expect(await claimActivationToken(token)).toEqual({ ok: false });
  });
});

describe("releaseActivationTokenLease", () => {
  it("[clears the lease] on a still-pending token, allowing a future reclaim", async () => {
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: "d".repeat(64), expires_at: futureIso(60_000), used_at: null, revoked_at: null, processing_started_at: new Date().toISOString() }]);
    const { releaseActivationTokenLease } = await import("./activationTokenPersistence");

    await releaseActivationTokenLease("row-1");

    expect(tableState.rows[0].processing_started_at).toBeNull();
  });

  it("[never resurrects a used or revoked token] the lease is left alone if used_at/revoked_at is already set", async () => {
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: "e".repeat(64), expires_at: futureIso(60_000), used_at: pastIso(1000), revoked_at: null, processing_started_at: "should-not-be-cleared" }]);
    const { releaseActivationTokenLease } = await import("./activationTokenPersistence");

    await releaseActivationTokenLease("row-1");

    expect(tableState.rows[0].processing_started_at).toBe("should-not-be-cleared");
  });
});

describe("markActivationTokenUsed", () => {
  it("[12/18 — success sets used_at and clears the lease] returns true", async () => {
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: "f".repeat(64), expires_at: futureIso(60_000), used_at: null, revoked_at: null, processing_started_at: new Date().toISOString() }]);
    const { markActivationTokenUsed } = await import("./activationTokenPersistence");

    const marked = await markActivationTokenUsed("row-1");

    expect(marked).toBe(true);
    expect(tableState.rows[0].used_at).not.toBeNull();
    expect(tableState.rows[0].processing_started_at).toBeNull();
  });

  it("[never re-marks an already-used token] returns false, second call is a no-op", async () => {
    const usedAt = pastIso(1000);
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: "g".repeat(64), expires_at: futureIso(60_000), used_at: usedAt, revoked_at: null }]);
    const { markActivationTokenUsed } = await import("./activationTokenPersistence");

    expect(await markActivationTokenUsed("row-1")).toBe(false);
    expect(tableState.rows[0].used_at).toBe(usedAt);
  });
});

describe("getActiveActivationLinkStatus — admin read, never exposes the raw token or its hash", () => {
  it("[none] no rows for this hotel", async () => {
    resetTable();
    const { getActiveActivationLinkStatus } = await import("./activationTokenPersistence");
    expect(await getActiveActivationLinkStatus(HOTEL_ID)).toEqual({ status: "none" });
  });

  it("[pending] a still-active token reports its expiry, never its hash", async () => {
    const expiresAt = futureIso(60_000);
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: "h".repeat(64), expires_at: expiresAt, used_at: null, revoked_at: null }]);
    const { getActiveActivationLinkStatus } = await import("./activationTokenPersistence");

    const status = await getActiveActivationLinkStatus(HOTEL_ID);
    expect(status).toEqual({ status: "pending", expiresAt });
    expect(JSON.stringify(status)).not.toMatch(/h{64}/);
  });

  it("[expired token reports \"none\"] never distinguished from no-link-at-all", async () => {
    resetTable([{ id: "row-1", hotel_id: HOTEL_ID, token_hash: "i".repeat(64), expires_at: pastIso(1000), used_at: null, revoked_at: null }]);
    const { getActiveActivationLinkStatus } = await import("./activationTokenPersistence");
    expect(await getActiveActivationLinkStatus(HOTEL_ID)).toEqual({ status: "none" });
  });

  it("[cross-tenant] never reports another hotel's pending link", async () => {
    resetTable([{ id: "row-1", hotel_id: OTHER_HOTEL_ID, token_hash: "j".repeat(64), expires_at: futureIso(60_000), used_at: null, revoked_at: null }]);
    const { getActiveActivationLinkStatus } = await import("./activationTokenPersistence");
    expect(await getActiveActivationLinkStatus(HOTEL_ID)).toEqual({ status: "none" });
  });
});
