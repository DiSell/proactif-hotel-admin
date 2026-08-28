import { afterEach, describe, expect, it, vi } from "vitest";
import type { SendEmailInput, SendEmailResult } from "./types";

/**
 * sendEmail() is a thin, deliberately dumb delegate to whatever
 * getEmailProvider() returns (see provider.ts) — this is what makes the
 * provider isolated/swappable: feature code only ever imports sendEmail,
 * never a concrete provider. Verified here with a fake provider, not a
 * real network call.
 */

const mockSend = vi.fn<(input: SendEmailInput) => Promise<SendEmailResult>>(async () => ({ ok: true }));
const mockGetEmailProvider = vi.fn(() => ({ send: mockSend }));
vi.mock("./provider", () => ({
  getEmailProvider: () => mockGetEmailProvider(),
}));

afterEach(() => {
  mockSend.mockClear();
  mockGetEmailProvider.mockClear();
});

describe("sendEmail", () => {
  it("[delegates as-is] passes its input straight through to the configured provider's send()", async () => {
    const { sendEmail } = await import("./sendEmail");
    const input = { to: "a@example.com", subject: "Sujet", html: "<p>h</p>", text: "t" };

    await sendEmail(input);

    expect(mockSend).toHaveBeenCalledWith(input);
  });

  it("[result passed through unchanged] returns exactly what the provider returned", async () => {
    mockSend.mockResolvedValueOnce({ ok: false, error: "provider down" });
    const { sendEmail } = await import("./sendEmail");

    const result = await sendEmail({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(result).toEqual({ ok: false, error: "provider down" });
  });

  it("[provider resolved fresh per call] getEmailProvider() is consulted for each send — never cached at module load", async () => {
    const { sendEmail } = await import("./sendEmail");

    await sendEmail({ to: "a@example.com", subject: "s", html: "<p>h</p>", text: "t" });
    await sendEmail({ to: "b@example.com", subject: "s", html: "<p>h</p>", text: "t" });

    expect(mockGetEmailProvider).toHaveBeenCalledTimes(2);
  });
});
