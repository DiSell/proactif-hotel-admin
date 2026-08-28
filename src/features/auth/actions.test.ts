import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/types";

const actionsSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "actions.ts"), "utf8");

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

function fakeSessionSupabase(options: { signInError?: { message: string } | null; role?: string | null; userId?: string | null }) {
  const signOut = vi.fn(async () => ({ error: null }));
  return {
    _spies: { signOut },
    auth: {
      signInWithPassword: vi.fn(async () => ({
        data: { user: options.signInError ? null : { id: options.userId ?? "user-1" } },
        error: options.signInError ?? null,
      })),
      signOut,
      updateUser: vi.fn(async () => ({ error: null })),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: options.role !== undefined ? { role: options.role } : null }),
        }),
      }),
    }),
  };
}

async function expectRedirect(promise: Promise<unknown>, path: string) {
  await expect(promise).rejects.toMatchObject({ path });
}

function loginFormData(email: string, password: string): FormData {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

/**
 * Real invocation tests for requestPasswordReset — Supabase Auth Admin API
 * + the email module are mocked with controllable fake behavior (same
 * discipline as src/features/hotelUsers/actions.test.ts). The actual
 * anti-enumeration collapsing logic runs for real: every assertion below
 * checks the RETURNED STATE, which must be identical across every branch.
 */

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

interface GenerateLinkProperties {
  hashed_token: string;
  verification_type: string;
  redirect_to: string;
  email_otp: string;
  action_link: string;
}

const DEFAULT_RECOVERY_PROPERTIES: GenerateLinkProperties = {
  hashed_token: "recovery-token-xyz",
  verification_type: "recovery",
  redirect_to: "https://app.example.com/login/reset-password",
  email_otp: "654321",
  action_link: "https://project.supabase.co/auth/v1/verify?type=recovery&token=recovery-token-xyz",
};

interface FakeAdminOptions {
  generateLinkResult?: {
    data: { user: { id: string } | null; properties: GenerateLinkProperties | null };
    error: { message: string; code?: string } | null;
  };
  generateLinkThrows?: Error;
}

function fakeAdmin(options: FakeAdminOptions) {
  const generateLink = vi.fn(async () => {
    if (options.generateLinkThrows) throw options.generateLinkThrows;
    return (
      options.generateLinkResult ?? {
        data: { user: { id: "existing-user" }, properties: DEFAULT_RECOVERY_PROPERTIES },
        error: null,
      }
    );
  });
  return { _spies: { generateLink }, auth: { admin: { generateLink } } };
}

function formData(email: string): FormData {
  const data = new FormData();
  data.set("email", email);
  return data;
}

afterEach(() => {
  mockCreateAdminClient.mockReset();
  mockSendEmail.mockClear();
  mockSendEmail.mockResolvedValue({ ok: true });
  mockCreateClient.mockReset();
  mockCreateClientPortalClient.mockReset();
});

describe("requestPasswordReset — Supabase SMTP never reintroduced", () => {
  it("[source-level] resetPasswordForEmail/inviteUserByEmail are never CALLED — only generateLink + sendEmail() (a historical mention in a doc comment is fine, an actual call site is not)", () => {
    expect(actionsSource).not.toMatch(/\.resetPasswordForEmail\(/);
    expect(actionsSource).not.toMatch(/\.inviteUserByEmail\(/);
    expect(actionsSource).toMatch(/admin\.auth\.admin\.generateLink\(/);
    expect(actionsSource).toMatch(/sendEmail\(/);
  });
});

describe("requestPasswordReset", () => {
  it("[existing account] calls generateLink with type: 'recovery', not resetPasswordForEmail", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    await requestPasswordReset({ error: null, sent: false }, formData("jean@example.com"));

    expect(admin._spies.generateLink).toHaveBeenCalledWith({
      type: "recovery",
      email: "jean@example.com",
      options: { redirectTo: expect.any(String) },
    });
  });

  it("[existing account] sendEmail is called with a link containing token_hash + type=recovery", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    await requestPasswordReset({ error: null, sent: false }, formData("jean@example.com"));

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const [emailInput] = mockSendEmail.mock.calls[0];
    expect(emailInput.to).toBe("jean@example.com");
    expect(emailInput.html).toMatch(/token_hash=recovery-token-xyz&type=recovery/);
    expect(emailInput.html).toMatch(/https:\/\/app\.example\.com\/login\/reset-password\?token_hash=/);
  });

  it("[existing account] returns { error: null, sent: true }", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await requestPasswordReset({ error: null, sent: false }, formData("jean@example.com"));

    expect(result).toEqual({ error: null, sent: true });
  });

  it("[non-existent account] generateLink errors (no matching user) — sendEmail never called, but the SAME { error: null, sent: true } is returned", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User not found", code: "user_not_found" } },
    });
    mockCreateAdminClient.mockReturnValue(admin);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestPasswordReset({ error: null, sent: false }, formData("nobody@example.com"));

    expect(result).toEqual({ error: null, sent: true });
    expect(mockSendEmail).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("[anti-enumeration] existing vs non-existent account produce byte-for-byte identical responses", async () => {
    const { requestPasswordReset } = await import("./actions");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const adminExisting = fakeAdmin({});
    mockCreateAdminClient.mockReturnValueOnce(adminExisting);
    const resultExisting = await requestPasswordReset({ error: null, sent: false }, formData("real@example.com"));

    const adminMissing = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User not found", code: "user_not_found" } },
    });
    mockCreateAdminClient.mockReturnValueOnce(adminMissing);
    const resultMissing = await requestPasswordReset({ error: null, sent: false }, formData("fake@example.com"));

    expect(resultExisting).toEqual(resultMissing);

    vi.restoreAllMocks();
  });

  it("[anti-enumeration] an unexpected thrown exception ALSO produces the exact same generic response — never a distinguishable error state", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({ generateLinkThrows: new Error("ECONNRESET") });
    mockCreateAdminClient.mockReturnValue(admin);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestPasswordReset({ error: null, sent: false }, formData("jean@example.com"));

    expect(result).toEqual({ error: null, sent: true });

    vi.restoreAllMocks();
  });

  it("[provider failure on a real account] sendEmail failing is logged server-side but the user-visible response is unchanged", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);
    mockSendEmail.mockResolvedValueOnce({ ok: false, error: "provider down" });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestPasswordReset({ error: null, sent: false }, formData("jean@example.com"));

    expect(result).toEqual({ error: null, sent: true });
    const loggedCall = consoleErrorSpy.mock.calls.find(([label]) => label === "sendPasswordResetEmail: sendEmail failed");
    expect(loggedCall).toBeTruthy();

    consoleErrorSpy.mockRestore();
  });

  it("[no secret/token ever logged] no console.error call anywhere contains the hashed_token value", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await requestPasswordReset({ error: null, sent: false }, formData("jean@example.com"));

    for (const call of consoleErrorSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/recovery-token-xyz/);
    }
    consoleErrorSpy.mockRestore();
  });

  it("[empty email] rejected before ever calling the admin API — distinct client-side validation message, not the generic anti-enumeration one", async () => {
    const { requestPasswordReset } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    const result = await requestPasswordReset({ error: null, sent: false }, formData(""));

    expect(result).toEqual({ error: "Entrez votre email.", sent: false });
    expect(admin._spies.generateLink).not.toHaveBeenCalled();
  });
});

describe("requestClientPasswordReset — client-portal mirror of requestPasswordReset", () => {
  it("[redirectTo points to the client-scoped reset page] not /login/reset-password", async () => {
    const { requestClientPasswordReset } = await import("./actions");
    const admin = fakeAdmin({});
    mockCreateAdminClient.mockReturnValue(admin);

    await requestClientPasswordReset({ error: null, sent: false }, formData("jean@example.com"));

    expect(admin._spies.generateLink).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ redirectTo: "https://app.example.com/client/login/reset-password" }) })
    );
  });

  it("[same anti-enumeration guarantee] a non-existent account still returns { error: null, sent: true }", async () => {
    const { requestClientPasswordReset } = await import("./actions");
    const admin = fakeAdmin({
      generateLinkResult: { data: { user: null, properties: null }, error: { message: "User not found", code: "user_not_found" } },
    });
    mockCreateAdminClient.mockReturnValue(admin);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await requestClientPasswordReset({ error: null, sent: false }, formData("nobody@example.com"));

    expect(result).toEqual({ error: null, sent: true });
    vi.restoreAllMocks();
  });
});

/**
 * login/clientLogin — each must write and read ONLY its own cookie scope
 * (lib/supabase/cookieScope.ts), and reject the other role's account rather
 * than leave a stray, wrongly-scoped session behind. This is the exact
 * regression a shared /login form used to cause: a hotel_admin signing in
 * there got a session under the back-office cookie, invisible to every
 * client-portal page, and bounced back to /login forever.
 */
describe("login — back-office scope, rejects a hotel_admin account", () => {
  it("[superadmin] signs in on the back-office scope only, redirects to /dashboard, never touches the client-portal scope", async () => {
    const { login } = await import("./actions");
    const backoffice = fakeSessionSupabase({ role: "superadmin" });
    mockCreateClient.mockResolvedValue(backoffice);

    await expectRedirect(login({ error: null }, loginFormData("admin@example.com", "hunter2")), "/dashboard");

    expect(backoffice._spies.signOut).not.toHaveBeenCalled();
    expect(mockCreateClientPortalClient).not.toHaveBeenCalled();
  });

  it("[hotel_admin credentials] signs the stray back-office session back out immediately and returns an error pointing to /client/login — never redirects to /dashboard", async () => {
    const { login } = await import("./actions");
    const backoffice = fakeSessionSupabase({ role: "hotel_admin" });
    mockCreateClient.mockResolvedValue(backoffice);

    const result = await login({ error: null }, loginFormData("client@example.com", "hunter2"));

    expect(result.error).toMatch(/espace client/);
    expect(backoffice._spies.signOut).toHaveBeenCalledTimes(1);
  });

  it("[wrong password] generic error, no scope ever touched beyond the sign-in attempt itself", async () => {
    const { login } = await import("./actions");
    const backoffice = fakeSessionSupabase({ signInError: { message: "Invalid login credentials" } });
    mockCreateClient.mockResolvedValue(backoffice);

    const result = await login({ error: null }, loginFormData("admin@example.com", "wrong"));

    expect(result.error).toBe("Identifiants incorrects.");
    expect(mockCreateClientPortalClient).not.toHaveBeenCalled();
  });
});

describe("clientLogin — client-portal scope, rejects a superadmin account", () => {
  it("[hotel_admin] signs in on the client-portal scope only, redirects to /client/dashboard, never touches the back-office scope", async () => {
    const { clientLogin } = await import("./actions");
    const portal = fakeSessionSupabase({ role: "hotel_admin" });
    mockCreateClientPortalClient.mockResolvedValue(portal);

    await expectRedirect(clientLogin({ error: null }, loginFormData("client@example.com", "hunter2")), "/client/dashboard");

    expect(portal._spies.signOut).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("[superadmin credentials] signs the stray client-portal session back out immediately and returns an error pointing to /login — never redirects to /client/dashboard", async () => {
    const { clientLogin } = await import("./actions");
    const portal = fakeSessionSupabase({ role: "superadmin" });
    mockCreateClientPortalClient.mockResolvedValue(portal);

    const result = await clientLogin({ error: null }, loginFormData("admin@example.com", "hunter2"));

    expect(result.error).toMatch(/back-office/);
    expect(portal._spies.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("logout / clientLogout — independent, each clears only its own scope", () => {
  it("[logout] uses createClient() (back-office) only, redirects to /login", async () => {
    const { logout } = await import("./actions");
    const backoffice = fakeSessionSupabase({});
    mockCreateClient.mockResolvedValue(backoffice);

    await expectRedirect(logout(), "/login");

    expect(backoffice._spies.signOut).toHaveBeenCalledTimes(1);
    expect(mockCreateClientPortalClient).not.toHaveBeenCalled();
  });

  it("[clientLogout] uses createClientPortalClient() only, redirects to /client/login", async () => {
    const { clientLogout } = await import("./actions");
    const portal = fakeSessionSupabase({});
    mockCreateClientPortalClient.mockResolvedValue(portal);

    await expectRedirect(clientLogout(), "/client/login");

    expect(portal._spies.signOut).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe("updatePassword / updateClientPassword — each reads/writes only its own scope", () => {
  function passwordFormData(): FormData {
    const data = new FormData();
    data.set("password", "a-long-enough-password");
    data.set("confirmPassword", "a-long-enough-password");
    return data;
  }

  it("[updatePassword] calls updateUser on the back-office client only", async () => {
    const { updatePassword } = await import("./actions");
    const backoffice = fakeSessionSupabase({});
    mockCreateClient.mockResolvedValue(backoffice);

    const result = await updatePassword({ error: null, success: false }, passwordFormData());

    expect(result.success).toBe(true);
    expect(backoffice.auth.updateUser).toHaveBeenCalledWith({ password: "a-long-enough-password" });
    expect(mockCreateClientPortalClient).not.toHaveBeenCalled();
  });

  it("[updateClientPassword] calls updateUser on the client-portal client only", async () => {
    const { updateClientPassword } = await import("./actions");
    const portal = fakeSessionSupabase({});
    mockCreateClientPortalClient.mockResolvedValue(portal);

    const result = await updateClientPassword({ error: null, success: false }, passwordFormData());

    expect(result.success).toBe(true);
    expect(portal.auth.updateUser).toHaveBeenCalledWith({ password: "a-long-enough-password" });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
