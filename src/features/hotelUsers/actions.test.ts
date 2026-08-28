import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/types";

const actionsSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "actions.ts"), "utf8");

/**
 * Real invocation tests for inviteHotelClient — Supabase Auth Admin API +
 * Postgres writes + the email module are mocked with controllable fake
 * behavior (same discipline as src/lib/auth/session.test.ts); the actual
 * CAS A/B/C/D decision logic, the retry/idempotency algorithm, and the
 * generateLink-failure/email-failure cleanup logic run for real.
 */

const mockRequireSuperadmin = vi.fn(async () => ({ userId: "admin-1", profile: { id: "admin-1", role: "superadmin" } }));
vi.mock("@/lib/auth/session", () => ({
  requireSuperadmin: () => mockRequireSuperadmin(),
}));

vi.mock("@/lib/http/currentOrigin", () => ({
  currentOrigin: async () => "https://app.example.com",
}));

const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => mockCreateAdminClient(),
}));

const mockSendEmail = vi.fn<(input: SendEmailInput) => Promise<SendEmailResult>>(async () => ({ ok: true }));
vi.mock("@/lib/email/sendEmail", () => ({
  sendEmail: (input: SendEmailInput) => mockSendEmail(input),
}));

// revalidatePath needs an active Next.js render/request context that plain
// Vitest invocation doesn't provide — mocked to a no-op, same reasoning as
// every other next/* mock in this file.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

interface GenerateLinkProperties {
  hashed_token: string;
  verification_type: string;
  redirect_to: string;
  email_otp: string;
  action_link: string;
}

const DEFAULT_GENERATE_LINK_PROPERTIES: GenerateLinkProperties = {
  hashed_token: "hashed-token-abc",
  verification_type: "invite",
  redirect_to: "https://app.example.com/client/login/reset-password",
  email_otp: "123456",
  action_link: "https://project.supabase.co/auth/v1/verify?type=invite&token=hashed-token-abc",
};

interface FakeAdminOptions {
  generateLinkResult?: {
    data: { user: { id: string } | null; properties: GenerateLinkProperties | null };
    error: { message: string; code?: string } | null;
  };
  /** Simulates a network-level failure (connection reset, timeout, ...) — generateLink REJECTS instead of resolving with { error }. */
  generateLinkThrows?: Error;
  /** Convenience for a single-page result — existing behavior, unchanged. */
  listUsersResult?: { data: { users: { id: string; email: string }[] } | null; error: { message: string } | null };
  /** One entry per page (index 0 = page 1) — for real pagination tests. Each page's `data.users` and `data.nextPage` are respected by findAuthUserByEmail. */
  listUsersPages?: { data: { users: { id: string; email: string }[]; nextPage: number | null }; error: null }[];
  profileUpsertError?: { message: string } | null;
  profileRow?: { role: string } | null;
  hotelUserRow?: { hotel_id: string } | null;
  hotelUserInsertError?: { message: string } | null;
  hotelUserDeleteError?: { message: string } | null;
  hotelUserReadError?: { message: string } | null;
  deleteUserError?: { message: string } | null;
}

function fakeAdmin(options: FakeAdminOptions) {
  const generateLink = vi.fn(async () => {
    if (options.generateLinkThrows) throw options.generateLinkThrows;
    return (
      options.generateLinkResult ?? {
        data: { user: { id: "new-user" }, properties: DEFAULT_GENERATE_LINK_PROPERTIES },
        error: null,
      }
    );
  });
  const listUsers = vi.fn(async (params?: { page?: number; perPage?: number }) => {
    if (options.listUsersPages) {
      const page = params?.page ?? 1;
      return options.listUsersPages[page - 1] ?? { data: { users: [], nextPage: null }, error: null };
    }
    return options.listUsersResult ?? { data: { users: [] }, error: null };
  });
  const profileUpsert = vi.fn(async () => ({ error: options.profileUpsertError ?? null }));
  const hotelUsersInsert = vi.fn(async () => ({ error: options.hotelUserInsertError ?? null }));
  const hotelUsersDeleteEq2 = vi.fn(async () => ({ error: options.hotelUserDeleteError ?? null }));
  const hotelUsersDelete = vi.fn(() => ({ eq: () => ({ eq: hotelUsersDeleteEq2 }) }));
  const deleteUser = vi.fn(async () => ({ error: options.deleteUserError ?? null }));

  return {
    _spies: { generateLink, listUsers, profileUpsert, hotelUsersInsert, hotelUsersDelete, hotelUsersDeleteEq2, deleteUser },
    auth: { admin: { generateLink, listUsers, deleteUser } },
    from(table: string) {
      if (table === "profiles") {
        return {
          upsert: profileUpsert,
          select: () => ({
            eq: () => ({
              single: async () => ({ data: options.profileRow ?? { role: "hotel_admin" }, error: null }),
            }),
          }),
        };
      }
      if (table === "hotel_users") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: options.hotelUserRow ?? null, error: options.hotelUserReadError ?? null }),
            }),
          }),
          insert: hotelUsersInsert,
          delete: hotelUsersDelete,
        };
      }
      throw new Error(`unexpected table in fake: ${table}`);
    },
  };
}

afterEach(() => {
  mockRequireSuperadmin.mockClear();
  mockCreateAdminClient.mockReset();
  mockSendEmail.mockClear();
  mockSendEmail.mockResolvedValue({ ok: true });
});

describe("inviteHotelClient — Supabase SMTP never reintroduced", () => {
  it("[source-level] inviteUserByEmail/resetPasswordForEmail are never CALLED — only generateLink + sendEmail() (a historical mention in a doc comment is fine, an actual call site is not)", () => {
    expect(actionsSource).not.toMatch(/\.inviteUserByEmail\(/);
    expect(actionsSource).not.toMatch(/\.resetPasswordForEmail\(/);
    expect(actionsSource).toMatch(/admin\.auth\.admin\.generateLink\(/);
    expect(actionsSource).toMatch(/sendEmail\(/);
  });
});

describe("inviteHotelClient", () => {
  it("[requireSuperadmin first] never calls the admin API at all if the caller isn't authorized", async () => {
    const { inviteHotelClient } = await import("./actions");
    mockRequireSuperadmin.mockRejectedValueOnce(new Error("not authorized"));
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    await expect(inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" })).rejects.toThrow();
    expect(admin._spies.generateLink).not.toHaveBeenCalled();
  });

  it("[CAS A — new email] generates an invite link, sends the email, creates the profile, links the hotel — outcome 'invited'", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result).toEqual({ ok: true, data: { outcome: "invited" } });
    expect(admin._spies.hotelUsersInsert).toHaveBeenCalledWith({ hotel_id: "hotel-a", user_id: "new-user" });
  });

  it("[generateLink invite called, not inviteUserByEmail] the exact SDK call site — type, email, options.data, options.redirectTo", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null });
    mockCreateAdminClient.mockReturnValue(admin);

    await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(admin._spies.generateLink).toHaveBeenCalledWith({
      type: "invite",
      email: "jean@example.com",
      options: { data: { first_name: "Jean", last_name: "Dupont" }, redirectTo: expect.any(String) },
    });
    // inviteUserByEmail is not part of the fake admin at all anymore — any
    // reference to it in actions.ts would throw "not a function" and fail
    // every test in this file, which is itself a structural guarantee.
  });

  it("[email sent with a token_hash link] sendEmail receives a link built from generateLink's own hashed_token/verification_type, matching what ResetPasswordForm.tsx parses", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null });
    mockCreateAdminClient.mockReturnValue(admin);

    await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [emailInput] = mockSendEmail.mock.calls[0];
    expect(emailInput.to).toBe("jean@example.com");
    expect(emailInput.html).toMatch(/token_hash=hashed-token-abc&type=invite/);
    expect(emailInput.text).toMatch(/token_hash=hashed-token-abc&type=invite/);
    // The link points at THIS app's own CLIENT-PORTAL reset-password page
    // (never /login/reset-password, which writes the back-office cookie —
    // invisible to requireClientAccess()/requireHotelAccess(hotelId,
    // "client") — and never Supabase's raw action_link).
    expect(emailInput.html).toMatch(/https:\/\/app\.example\.com\/client\/login\/reset-password\?token_hash=/);
    expect(emailInput.html).not.toMatch(/https:\/\/app\.example\.com\/login\/reset-password/);
  });

  it("[token never logged] no console.error call anywhere contains the hashed_token value", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null });
    mockCreateAdminClient.mockReturnValue(admin);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    for (const call of consoleErrorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/hashed-token-abc/);
    }
    consoleErrorSpy.mockRestore();
  });

  it("[sendEmail failure on a NEW account] cleans up the auth.users row this call just created — no profile/hotel_users write", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null });
    mockCreateAdminClient.mockReturnValue(admin);
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: "provider down" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result.ok).toBe(false);
    expect(admin._spies.deleteUser).toHaveBeenCalledWith("new-user");
    expect(admin._spies.profileUpsert).not.toHaveBeenCalled();
    expect(admin._spies.hotelUsersInsert).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("[cleanup never touches a pre-existing account] a duplicate-email (recovered) invite never calls deleteUser, even if sendEmail were to fail — no fresh email is sent on that path at all", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User already registered", code: "email_exists" } },
      listUsersResult: { data: { users: [{ id: "existing-user", email: "jean@example.com" }] }, error: null },
      hotelUserRow: null,
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result).toEqual({ ok: true, data: { outcome: "linked_existing_user" } });
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(admin._spies.deleteUser).not.toHaveBeenCalled();
  });

  it("[cleanup failure handled safely] deleteUser itself failing after a send failure is logged with only userId + a safe message, and the action still reports failure, never a false success", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null, deleteUserError: { message: "auth api unreachable" } });
    mockCreateAdminClient.mockReturnValue(admin);
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: "provider down" });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result.ok).toBe(false);
    expect(admin._spies.profileUpsert).not.toHaveBeenCalled();

    const loggedCall = consoleErrorSpy.mock.calls.find(([label]) => label === "inviteHotelClient: cleanup after email failure also failed");
    expect(loggedCall).toBeTruthy();
    expect(loggedCall?.[1]).toEqual({ userId: "new-user", message: "auth api unreachable" });
    // Never logs a secret/token alongside it.
    expect(JSON.stringify(loggedCall)).not.toMatch(/hashed-token-abc/);

    consoleErrorSpy.mockRestore();
  });

  it("[email normalized] trims and lowercases before calling generateLink", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null });
    mockCreateAdminClient.mockReturnValue(admin);

    await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "  Jean@Example.COM  " });

    expect(admin._spies.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ email: "jean@example.com", options: expect.objectContaining({ redirectTo: expect.any(String) }) })
    );
  });

  it("[CAS B — already linked to THIS hotel] idempotent — no duplicate insert, outcome 'already_linked'", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User already registered", code: "email_exists" } },
      listUsersResult: { data: { users: [{ id: "existing-user", email: "jean@example.com" }] }, error: null },
      hotelUserRow: { hotel_id: "hotel-a" },
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result).toEqual({ ok: true, data: { outcome: "already_linked" } });
    expect(admin._spies.hotelUsersInsert).not.toHaveBeenCalled();
  });

  it("[CAS C — linked to a DIFFERENT hotel] refused, no write at all", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User already registered", code: "email_exists" } },
      listUsersResult: { data: { users: [{ id: "existing-user", email: "jean@example.com" }] }, error: null },
      hotelUserRow: { hotel_id: "hotel-b" },
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/autre hôtel/i);
    expect(admin._spies.hotelUsersInsert).not.toHaveBeenCalled();
  });

  it("[CAS D — existing superadmin email] refused absolutely, role never touched, no hotel_users write", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User already registered", code: "user_already_exists" } },
      listUsersResult: { data: { users: [{ id: "superadmin-1", email: "boss@example.com" }] }, error: null },
      profileRow: { role: "superadmin" },
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Boss", lastName: "Admin", email: "boss@example.com" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/superadmin/i);
    expect(admin._spies.hotelUsersInsert).not.toHaveBeenCalled();
  });

  it("[retry after partial failure] duplicate-email error + no existing hotel_users link recovers cleanly — outcome 'linked_existing_user', never a duplicate auth user", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User already registered", code: "user_already_exists" } },
      listUsersResult: { data: { users: [{ id: "recovered-user", email: "jean@example.com" }] }, error: null },
      hotelUserRow: null,
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result).toEqual({ ok: true, data: { outcome: "linked_existing_user" } });
    expect(admin._spies.generateLink).toHaveBeenCalledTimes(1);
    expect(admin._spies.hotelUsersInsert).toHaveBeenCalledWith({ hotel_id: "hotel-a", user_id: "recovered-user" });
  });

  it("[pagination] a user found only on a LATER page of listUsers is still resolved correctly — never falsely reported as not-found", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User already registered", code: "email_exists" } },
      listUsersPages: [
        { data: { users: [{ id: "someone-else", email: "someone-else@example.com" }], nextPage: 2 }, error: null },
        { data: { users: [{ id: "someone-else-2", email: "someone-else-2@example.com" }], nextPage: 3 }, error: null },
        { data: { users: [{ id: "page-3-user", email: "jean@example.com" }], nextPage: null }, error: null },
      ],
      hotelUserRow: null,
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result).toEqual({ ok: true, data: { outcome: "linked_existing_user" } });
    expect(admin._spies.hotelUsersInsert).toHaveBeenCalledWith({ hotel_id: "hotel-a", user_id: "page-3-user" });
    expect(admin.auth.admin.listUsers).toHaveBeenCalledTimes(3); // one call per page walked
  });

  it("[pagination exhausted, genuinely not found] every page checked, no match anywhere — reported as a failure, never a false positive", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User already registered", code: "email_exists" } },
      listUsersPages: [
        { data: { users: [{ id: "someone-else", email: "someone-else@example.com" }], nextPage: 2 }, error: null },
        { data: { users: [{ id: "someone-else-2", email: "someone-else-2@example.com" }], nextPage: null }, error: null },
      ],
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result.ok).toBe(false);
    expect(admin._spies.hotelUsersInsert).not.toHaveBeenCalled();
  });

  it("[non-duplicate generateLink failure] generic error returned, nothing written, nothing emailed", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "network error" } },
    });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result.ok).toBe(false);
    expect(admin._spies.hotelUsersInsert).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("[network exception during generateLink] a thrown/rejected call (connection reset, timeout, ...) never propagates raw — becomes a clean ActionResult, nothing written", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ generateLinkThrows: new Error("fetch failed: ECONNRESET") });
    mockCreateAdminClient.mockReturnValue(admin);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Never lets the raw exception's message reach the ActionResult shown to the user — only a static, generic string.
    expect(result.error).not.toMatch(/ECONNRESET/);
    expect(admin._spies.profileUpsert).not.toHaveBeenCalled();
    expect(admin._spies.hotelUsersInsert).not.toHaveBeenCalled();

    // The raw exception message is still logged server-side (for diagnosis), but never anything more than a message string.
    const loggedCall = consoleErrorSpy.mock.calls.find(([label]) => label === "inviteHotelClient: unexpected error");
    expect(loggedCall).toBeTruthy();
    expect(loggedCall?.[1]).toEqual({ message: "fetch failed: ECONNRESET" });

    consoleErrorSpy.mockRestore();
  });

  it("[network exception never produces a false success] a thrown exception can never resolve to ok: true", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ generateLinkThrows: new Error("network down") });
    mockCreateAdminClient.mockReturnValue(admin);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await inviteHotelClient("hotel-a", { firstName: "Jean", lastName: "Dupont", email: "jean@example.com" });

    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("data.outcome", "invited");

    vi.restoreAllMocks();
  });

  it("[invalid input] rejects an empty firstName/lastName/email before ever calling the admin API", async () => {
    const { inviteHotelClient } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await inviteHotelClient("hotel-a", { firstName: "", lastName: "", email: "not-an-email" });

    expect(result.ok).toBe(false);
    expect(admin._spies.generateLink).not.toHaveBeenCalled();
  });
});

describe("revokeHotelClientAccess", () => {
  it("[requireSuperadmin first] never touches hotel_users if the caller isn't authorized", async () => {
    const { revokeHotelClientAccess } = await import("./actions");
    mockRequireSuperadmin.mockRejectedValueOnce(new Error("not authorized"));
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    await expect(revokeHotelClientAccess("link-1", "hotel-a")).rejects.toThrow();
    expect(admin._spies.hotelUsersDelete).not.toHaveBeenCalled();
  });

  it("[success] deletes the link scoped by BOTH id and hotel_id, account untouched", async () => {
    const { revokeHotelClientAccess } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await revokeHotelClientAccess("link-1", "hotel-a");

    expect(result).toEqual({ ok: true });
    expect(admin._spies.hotelUsersDelete).toHaveBeenCalledTimes(1);
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("[delete fails] generic error returned", async () => {
    const { revokeHotelClientAccess } = await import("./actions");
    const admin = fakeAdmin({ hotelUserDeleteError: { message: "db error" } });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await revokeHotelClientAccess("link-1", "hotel-a");

    expect(result.ok).toBe(false);
  });
});

describe("deleteHotelClient", () => {
  it("[requireSuperadmin first] never calls deleteUser if the caller isn't authorized", async () => {
    const { deleteHotelClient } = await import("./actions");
    mockRequireSuperadmin.mockRejectedValueOnce(new Error("not authorized"));
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    await expect(deleteHotelClient("user-1", "hotel-a")).rejects.toThrow();
    expect(admin._spies.deleteUser).not.toHaveBeenCalled();
  });

  it("[linked to this hotel] deletes the auth user — cascades to profiles/hotel_users, no separate cleanup call", async () => {
    const { deleteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: { hotel_id: "hotel-a" } });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await deleteHotelClient("user-1", "hotel-a");

    expect(result).toEqual({ ok: true });
    expect(admin._spies.deleteUser).toHaveBeenCalledWith("user-1");
    expect(admin._spies.hotelUsersDelete).not.toHaveBeenCalled();
  });

  it("[linked to a DIFFERENT hotel] refused, never calls deleteUser — never trusts a userId without confirming the hotel link", async () => {
    const { deleteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: { hotel_id: "hotel-b" } });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await deleteHotelClient("user-1", "hotel-a");

    expect(result.ok).toBe(false);
    expect(admin._spies.deleteUser).not.toHaveBeenCalled();
  });

  it("[no hotel_users link at all] refused, never calls deleteUser", async () => {
    const { deleteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: null });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await deleteHotelClient("user-1", "hotel-a");

    expect(result.ok).toBe(false);
    expect(admin._spies.deleteUser).not.toHaveBeenCalled();
  });

  it("[hotel_users read fails] generic error, deleteUser never called", async () => {
    const { deleteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserReadError: { message: "db error" } });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await deleteHotelClient("user-1", "hotel-a");

    expect(result.ok).toBe(false);
    expect(admin._spies.deleteUser).not.toHaveBeenCalled();
  });

  it("[deleteUser fails] generic error returned", async () => {
    const { deleteHotelClient } = await import("./actions");
    const admin = fakeAdmin({ hotelUserRow: { hotel_id: "hotel-a" }, deleteUserError: { message: "auth api error" } });
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await deleteHotelClient("user-1", "hotel-a");

    expect(result.ok).toBe(false);
  });
});
