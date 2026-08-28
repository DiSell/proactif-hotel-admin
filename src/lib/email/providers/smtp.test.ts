import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Real invocation tests for the SMTP provider — nodemailer's
 * createTransport/sendMail are mocked with controllable fake behavior, no
 * real network connection is ever attempted. readSmtpConfigFromEnv() reads
 * process.env directly, so each test sets exactly the vars it needs and
 * this file resets them afterward.
 */

const ORIGINAL_ENV = { ...process.env };

const mockSendMail = vi.fn(async () => ({ messageId: "id-1" }));
const mockCreateTransport = vi.fn<(options: unknown) => { sendMail: typeof mockSendMail }>(() => ({ sendMail: mockSendMail }));
vi.mock("nodemailer", () => ({
  createTransport: (options: unknown) => mockCreateTransport(options),
}));

beforeEach(() => {
  delete process.env.EMAIL_SMTP_HOST;
  delete process.env.EMAIL_SMTP_PORT;
  delete process.env.EMAIL_SMTP_USER;
  delete process.env.EMAIL_SMTP_PASSWORD;
  delete process.env.EMAIL_FROM_ADDRESS;
  delete process.env.EMAIL_FROM_NAME;
  mockSendMail.mockClear();
  mockCreateTransport.mockClear();
  mockSendMail.mockResolvedValue({ messageId: "id-1" });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

function setFullConfig(overrides: Partial<Record<string, string>> = {}) {
  process.env.EMAIL_SMTP_HOST = "smtp.example.com";
  process.env.EMAIL_SMTP_PORT = "465";
  process.env.EMAIL_SMTP_USER = "contact@example.com";
  process.env.EMAIL_SMTP_PASSWORD = "s3cr3t-password";
  process.env.EMAIL_FROM_ADDRESS = "contact@example.com";
  Object.assign(process.env, overrides);
}

describe("readSmtpConfigFromEnv", () => {
  it("[all vars set] returns a config object with the port parsed as a number", async () => {
    setFullConfig();
    const { readSmtpConfigFromEnv } = await import("./smtp");

    const config = readSmtpConfigFromEnv();

    expect(config).toEqual({
      host: "smtp.example.com",
      port: 465,
      user: "contact@example.com",
      password: "s3cr3t-password",
      fromAddress: "contact@example.com",
      fromName: "Proactif System",
    });
  });

  it("[EMAIL_FROM_NAME set] overrides the default", async () => {
    setFullConfig({ EMAIL_FROM_NAME: "Proactif Support" });
    const { readSmtpConfigFromEnv } = await import("./smtp");

    expect(readSmtpConfigFromEnv()?.fromName).toBe("Proactif Support");
  });

  it.each(["EMAIL_SMTP_HOST", "EMAIL_SMTP_PORT", "EMAIL_SMTP_USER", "EMAIL_SMTP_PASSWORD", "EMAIL_FROM_ADDRESS"])(
    "[%s missing] returns null — every required value must be present",
    async (missingVar) => {
      setFullConfig();
      delete process.env[missingVar];
      const { readSmtpConfigFromEnv } = await import("./smtp");

      expect(readSmtpConfigFromEnv()).toBeNull();
    }
  );

  it.each(["not-a-number", "0", "-1", ""])("[invalid port %s] returns null", async (badPort) => {
    setFullConfig({ EMAIL_SMTP_PORT: badPort });
    const { readSmtpConfigFromEnv } = await import("./smtp");

    expect(readSmtpConfigFromEnv()).toBeNull();
  });

  it("[no vars at all] returns null", async () => {
    const { readSmtpConfigFromEnv } = await import("./smtp");
    expect(readSmtpConfigFromEnv()).toBeNull();
  });
});

describe("createSmtpProvider", () => {
  it("[port 465] secure: true — implicit TLS", async () => {
    const { createSmtpProvider } = await import("./smtp");
    createSmtpProvider({ host: "smtp.example.com", port: 465, user: "u", password: "p", fromAddress: "a@example.com", fromName: "N" });

    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 465, secure: true }));
  });

  it("[port 587] secure: false — no automatic fallback between modes", async () => {
    const { createSmtpProvider } = await import("./smtp");
    createSmtpProvider({ host: "smtp.example.com", port: 587, user: "u", password: "p", fromAddress: "a@example.com", fromName: "N" });

    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false }));
  });

  it("[host/port/auth transmitted correctly] the exact config values reach nodemailer's createTransport, nothing hardcoded", async () => {
    const { createSmtpProvider } = await import("./smtp");
    createSmtpProvider({
      host: "custom-host.example.net",
      port: 2525,
      user: "custom-user",
      password: "custom-pass",
      fromAddress: "a@example.com",
      fromName: "N",
    });

    expect(mockCreateTransport).toHaveBeenCalledWith({
      host: "custom-host.example.net",
      port: 2525,
      secure: false,
      auth: { user: "custom-user", pass: "custom-pass" },
    });
  });

  it("[from header built from config] name/address are combined, never hardcoded", async () => {
    const { createSmtpProvider } = await import("./smtp");
    const provider = createSmtpProvider({
      host: "smtp.example.com",
      port: 465,
      user: "u",
      password: "p",
      fromAddress: "contact@proactifsystem.com",
      fromName: "Proactif System",
    });

    await provider.send({ to: "client@example.com", subject: "Sujet", html: "<p>h</p>", text: "t" });

    expect(mockSendMail).toHaveBeenCalledWith({
      from: '"Proactif System" <contact@proactifsystem.com>',
      to: "client@example.com",
      subject: "Sujet",
      html: "<p>h</p>",
      text: "t",
    });
  });

  it("[send success] resolves { ok: true }", async () => {
    const { createSmtpProvider } = await import("./smtp");
    const provider = createSmtpProvider({ host: "h", port: 465, user: "u", password: "p", fromAddress: "a@example.com", fromName: "N" });

    const result = await provider.send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result).toEqual({ ok: true });
  });

  it("[send failure] resolves { ok: false } with a safe generic error, never the raw exception message", async () => {
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error("535 Authentication failed"), { code: "EAUTH" }));
    const { createSmtpProvider } = await import("./smtp");
    const provider = createSmtpProvider({ host: "h", port: 465, user: "u", password: "p", fromAddress: "a@example.com", fromName: "N" });

    const result = await provider.send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toMatch(/Authentication failed/);
  });

  it("[password never exposed in the result] the returned SendEmailResult never contains the SMTP password, on success or failure", async () => {
    const password = "s3cr3t-password";
    mockSendMail.mockRejectedValueOnce(new Error("connection failed"));
    const { createSmtpProvider } = await import("./smtp");
    const provider = createSmtpProvider({ host: "h", port: 465, user: "u", password, fromAddress: "a@example.com", fromName: "N" });

    const result = await provider.send({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("[no secret logged] a failure logs only code/message, never the SMTP password, never the email body/link", async () => {
    const password = "s3cr3t-password";
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSendMail.mockRejectedValueOnce(Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" }));
    const { createSmtpProvider } = await import("./smtp");
    const provider = createSmtpProvider({ host: "h", port: 465, user: "u", password, fromAddress: "a@example.com", fromName: "N" });

    await provider.send({
      to: "a@example.com",
      subject: "s",
      html: '<a href="https://app.example.com/login/reset-password?token_hash=super-secret-token&type=invite">Activer</a>',
      text: "https://app.example.com/login/reset-password?token_hash=super-secret-token&type=invite",
    });

    for (const call of consoleErrorSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(password);
      expect(serialized).not.toMatch(/super-secret-token/);
    }
    consoleErrorSpy.mockRestore();
  });
});
