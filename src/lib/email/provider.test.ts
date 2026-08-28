import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getEmailProvider() resolves either the SMTP provider (providers/smtp.ts)
 * when fully configured, or a safe not-configured fallback otherwise — see
 * provider.ts. nodemailer is mocked here too (createSmtpProvider itself is
 * exercised in full, with real invocation tests, in
 * providers/smtp.test.ts) — no real network call ever happens.
 */

const ORIGINAL_ENV = { ...process.env };

const mockSendMail = vi.fn(async () => ({ messageId: "id-1" }));
const mockCreateTransport = vi.fn<(options: unknown) => { sendMail: typeof mockSendMail }>(() => ({ sendMail: mockSendMail }));
vi.mock("nodemailer", () => ({
  createTransport: (options: unknown) => mockCreateTransport(options),
}));

function clearSmtpEnv() {
  delete process.env.EMAIL_SMTP_HOST;
  delete process.env.EMAIL_SMTP_PORT;
  delete process.env.EMAIL_SMTP_USER;
  delete process.env.EMAIL_SMTP_PASSWORD;
  delete process.env.EMAIL_FROM_ADDRESS;
  delete process.env.EMAIL_FROM_NAME;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  mockSendMail.mockClear();
  mockCreateTransport.mockClear();
  mockSendMail.mockResolvedValue({ messageId: "id-1" });
});

describe("getEmailProvider — not configured", () => {
  beforeEach(() => {
    clearSmtpEnv();
  });

  it("[always returns a provider, never null/undefined]", async () => {
    const { getEmailProvider } = await import("./provider");
    expect(getEmailProvider()).toBeTruthy();
  });

  it("[send() resolves { ok: false } with the exact expected message, never throws]", async () => {
    const { getEmailProvider } = await import("./provider");

    const result = await getEmailProvider().send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result).toEqual({ ok: false, error: "Email provider is not configured." });
  });

  it("[never touches the network] fetch is never called, nodemailer's createTransport is never called", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const { getEmailProvider } = await import("./provider");

    await getEmailProvider().send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockCreateTransport).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("[logged server-side, no secret involved] a diagnostic message is logged — nothing sensitive to leak since nothing is configured", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { getEmailProvider } = await import("./provider");

    await getEmailProvider().send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringMatching(/no provider configured/i));
    consoleErrorSpy.mockRestore();
  });

  it("[input ignored, still safe] any message shape still resolves the same safe result, never throws on unusual input", async () => {
    const { getEmailProvider } = await import("./provider");

    const result = await getEmailProvider().send({ to: "", subject: "", html: "", text: "" });

    expect(result.ok).toBe(false);
  });
});

describe("getEmailProvider — SMTP fully configured", () => {
  beforeEach(() => {
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_SMTP_PORT = "465";
    process.env.EMAIL_SMTP_USER = "contact@example.com";
    process.env.EMAIL_SMTP_PASSWORD = "s3cr3t-password";
    process.env.EMAIL_FROM_ADDRESS = "contact@example.com";
  });

  it("[uses the SMTP provider, not the not-configured fallback]", async () => {
    const { getEmailProvider } = await import("./provider");

    const result = await getEmailProvider().send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result).not.toEqual({ ok: false, error: "Email provider is not configured." });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it("[SMTP failure still resolves { ok: false } cleanly, never throws out of getEmailProvider().send()]", async () => {
    mockSendMail.mockRejectedValueOnce(new Error("connection refused"));
    const { getEmailProvider } = await import("./provider");

    const result = await getEmailProvider().send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result.ok).toBe(false);
  });
});

describe("sendEmail — provider-agnostic (integration through the real provider.ts)", () => {
  it("[not configured] sendEmail() itself never needs to know which concrete provider backs it", async () => {
    clearSmtpEnv();
    const { sendEmail } = await import("./sendEmail");

    const result = await sendEmail({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result).toEqual({ ok: false, error: "Email provider is not configured." });
  });

  it("[configured] the exact same sendEmail() call now actually reaches the SMTP transport, no code change needed at the call site", async () => {
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_SMTP_PORT = "465";
    process.env.EMAIL_SMTP_USER = "contact@example.com";
    process.env.EMAIL_SMTP_PASSWORD = "s3cr3t-password";
    process.env.EMAIL_FROM_ADDRESS = "contact@example.com";
    const { sendEmail } = await import("./sendEmail");

    const result = await sendEmail({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result).toEqual({ ok: true });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });
});
