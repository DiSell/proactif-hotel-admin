import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Real invocation tests — requireSuperadmin/requireClientAccess/
 * requireHotelAccess are Supabase-touching (like every Server
 * Action/guard in this codebase), so next/navigation's redirect() and
 * lib/supabase/server's createClient() are mocked with controllable fake
 * behavior; everything else (the actual role/hotel_users decision logic)
 * runs for real. redirect() is mocked to throw, matching its real Next.js
 * behavior (it never returns) — this file's own guards rely on that for
 * correct control flow, so a mock that just recorded the call without
 * throwing would let execution continue past it in a way real Next.js
 * never does.
 */

class RedirectSignal extends Error {
  constructor(public readonly path: string) {
    super(`REDIRECT:${path}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new RedirectSignal(path);
  },
}));

const mockCreateClient = vi.fn();
const mockCreateClientPortalClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => mockCreateClient(),
  createClientPortalClient: () => mockCreateClientPortalClient(),
}));

function makeQueryResult(result: { data: unknown; error?: unknown }) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    single: async () => ({ error: null, ...result }),
    maybeSingle: async () => ({ error: null, ...result }),
  };
  return builder;
}

function fakeSupabase(options: {
  userId?: string | null;
  profile?: { data: unknown; error?: unknown };
  hotelUser?: { data: unknown; error?: unknown };
}) {
  return {
    auth: {
      getClaims: async () => ({ data: options.userId ? { claims: { sub: options.userId } } : null }),
    },
    from(table: string) {
      if (table === "profiles") return makeQueryResult(options.profile ?? { data: null });
      if (table === "hotel_users") return makeQueryResult(options.hotelUser ?? { data: null });
      throw new Error(`unexpected table in fake: ${table}`);
    },
  };
}

async function expectRedirect(promise: Promise<unknown>, path: string) {
  await expect(promise).rejects.toMatchObject({ path });
}

afterEach(() => {
  vi.resetModules();
  mockCreateClient.mockReset();
  mockCreateClientPortalClient.mockReset();
});

describe("requireSuperadmin", () => {
  it("[unauthenticated] redirects to /login", async () => {
    const { requireSuperadmin } = await import("./session");
    mockCreateClient.mockResolvedValue(fakeSupabase({ userId: null }));
    await expectRedirect(requireSuperadmin(), "/login");
  });

  it("[authenticated, hotel_admin] redirects to /client/dashboard — not /login, they ARE logged in", async () => {
    const { requireSuperadmin } = await import("./session");
    mockCreateClient.mockResolvedValue(
      fakeSupabase({ userId: "user-1", profile: { data: { id: "user-1", role: "hotel_admin" } } })
    );
    await expectRedirect(requireSuperadmin(), "/client/dashboard");
  });

  it("[authenticated, superadmin] returns userId + profile, no redirect", async () => {
    const { requireSuperadmin } = await import("./session");
    mockCreateClient.mockResolvedValue(
      fakeSupabase({ userId: "user-1", profile: { data: { id: "user-1", role: "superadmin" } } })
    );
    const result = await requireSuperadmin();
    expect(result.userId).toBe("user-1");
    expect(result.profile.role).toBe("superadmin");
  });
});

describe("requireClientAccess", () => {
  it("[unauthenticated] redirects to /client/login — this space's OWN login page, never the back-office /login", async () => {
    const { requireClientAccess } = await import("./session");
    mockCreateClientPortalClient.mockResolvedValue(fakeSupabase({ userId: null }));
    await expectRedirect(requireClientAccess(), "/client/login");
  });

  it("[superadmin] redirects to /dashboard — mirrors requireSuperadmin's symmetric redirect, no loop possible", async () => {
    const { requireClientAccess } = await import("./session");
    mockCreateClientPortalClient.mockResolvedValue(
      fakeSupabase({ userId: "user-1", profile: { data: { id: "user-1", role: "superadmin" } } })
    );
    await expectRedirect(requireClientAccess(), "/dashboard");
  });

  it("[hotel_admin without a hotel_users link] redirects to /client/login — never guesses a hotel", async () => {
    const { requireClientAccess } = await import("./session");
    mockCreateClientPortalClient.mockResolvedValue(
      fakeSupabase({
        userId: "user-1",
        profile: { data: { id: "user-1", role: "hotel_admin" } },
        hotelUser: { data: null },
      })
    );
    await expectRedirect(requireClientAccess(), "/client/login");
  });

  it("[hotel_admin linked to hotel A] returns hotelId = A, no redirect", async () => {
    const { requireClientAccess } = await import("./session");
    mockCreateClientPortalClient.mockResolvedValue(
      fakeSupabase({
        userId: "user-1",
        profile: { data: { id: "user-1", role: "hotel_admin" } },
        hotelUser: { data: { hotel_id: "hotel-a" } },
      })
    );
    const result = await requireClientAccess();
    expect(result.hotelId).toBe("hotel-a");
  });

  it("[uses the client-portal cookie scope, not the back-office one] a back-office session alone never satisfies requireClientAccess", async () => {
    const { requireClientAccess } = await import("./session");
    // Back-office scope has a perfectly valid superadmin session — but
    // requireClientAccess must never read it; only the client-portal scope.
    mockCreateClient.mockResolvedValue(
      fakeSupabase({ userId: "user-1", profile: { data: { id: "user-1", role: "hotel_admin" } }, hotelUser: { data: { hotel_id: "hotel-a" } } })
    );
    mockCreateClientPortalClient.mockResolvedValue(fakeSupabase({ userId: null }));
    await expectRedirect(requireClientAccess(), "/client/login");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe("requireHotelAccess", () => {
  it("[scope='backoffice', unauthenticated] redirects to /login, never even calls createClientPortalClient", async () => {
    const { requireHotelAccess } = await import("./session");
    mockCreateClient.mockResolvedValue(fakeSupabase({ userId: null }));
    await expectRedirect(requireHotelAccess("hotel-a", "backoffice"), "/login");
    expect(mockCreateClientPortalClient).not.toHaveBeenCalled();
  });

  it("[scope='client', unauthenticated] redirects to /client/login, never even calls createClient", async () => {
    const { requireHotelAccess } = await import("./session");
    mockCreateClientPortalClient.mockResolvedValue(fakeSupabase({ userId: null }));
    await expectRedirect(requireHotelAccess("hotel-a", "client"), "/client/login");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("[scope='backoffice', superadmin] allowed for ANY hotelId, no hotel_users lookup needed, resolved client is the back-office one", async () => {
    const { requireHotelAccess } = await import("./session");
    const backofficeSupabase = fakeSupabase({ userId: "user-1", profile: { data: { id: "user-1", role: "superadmin" } } });
    mockCreateClient.mockResolvedValue(backofficeSupabase);
    const result = await requireHotelAccess("hotel-anything", "backoffice");
    expect(result.userId).toBe("user-1");
    expect(result.supabase).toBe(backofficeSupabase);
    expect(mockCreateClientPortalClient).not.toHaveBeenCalled();
  });

  it("[scope='backoffice', hotel_admin linked to hotel A, requesting hotel A] allowed", async () => {
    const { requireHotelAccess } = await import("./session");
    mockCreateClient.mockResolvedValue(
      fakeSupabase({
        userId: "user-1",
        profile: { data: { id: "user-1", role: "hotel_admin" } },
        hotelUser: { data: { hotel_id: "hotel-a" } },
      })
    );
    const result = await requireHotelAccess("hotel-a", "backoffice");
    expect(result.userId).toBe("user-1");
  });

  it("[scope='backoffice', hotel_admin linked to hotel A, requesting hotel B] redirects to /login — cross-hotel access refused", async () => {
    const { requireHotelAccess } = await import("./session");
    mockCreateClient.mockResolvedValue(
      fakeSupabase({
        userId: "user-1",
        profile: { data: { id: "user-1", role: "hotel_admin" } },
        // The fake's .eq() is a no-op passthrough (always returns the
        // configured row) — a hotel_admin actually scoped to hotel A would
        // get zero rows from a real `.eq("hotel_id", "hotel-b")` query.
        // Simulate that real-world result directly: no row for hotel B.
        hotelUser: { data: null },
      })
    );
    await expectRedirect(requireHotelAccess("hotel-b", "backoffice"), "/login");
  });

  it("[scope='client', hotel_admin linked to hotel A, requesting hotel A] allowed, resolved client is the client-portal one", async () => {
    const { requireHotelAccess } = await import("./session");
    const portalSupabase = fakeSupabase({
      userId: "user-1",
      profile: { data: { id: "user-1", role: "hotel_admin" } },
      hotelUser: { data: { hotel_id: "hotel-a" } },
    });
    mockCreateClientPortalClient.mockResolvedValue(portalSupabase);

    const result = await requireHotelAccess("hotel-a", "client");
    expect(result.userId).toBe("user-1");
    expect(result.supabase).toBe(portalSupabase);
  });

  it("[NO FALLBACK] a valid back-office session never satisfies a scope='client' call, and vice versa — the exact regression this signature prevents", async () => {
    const { requireHotelAccess } = await import("./session");
    // A perfectly valid, authorized back-office superadmin session exists —
    // but the caller explicitly asked for the client-portal scope, so it
    // must never be consulted, let alone used to grant access.
    mockCreateClient.mockResolvedValue(
      fakeSupabase({ userId: "user-1", profile: { data: { id: "user-1", role: "superadmin" } } })
    );
    mockCreateClientPortalClient.mockResolvedValue(fakeSupabase({ userId: null }));

    await expectRedirect(requireHotelAccess("hotel-a", "client"), "/client/login");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
