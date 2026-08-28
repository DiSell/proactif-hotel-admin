import { getEmailProvider } from "./provider";
import type { SendEmailInput, SendEmailResult } from "./types";

/**
 * The ONLY function feature code should ever call to send an email —
 * features/hotelUsers/actions.ts and features/auth/actions.ts import this
 * and nothing else from this module. Never throws: every failure mode
 * (missing config, network failure, provider rejection) resolves to
 * { ok: false, error }, safe to await directly without an extra try/catch
 * dedicated to this call.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const provider = getEmailProvider();
  return provider.send(input);
}
