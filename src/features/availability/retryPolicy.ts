import type { IntegrationErrorCode } from "./types";

/** Hard ceiling on the total wall-clock time a single checkAvailability call may spend across all attempts — a chatbot turn has to answer in a reasonable time regardless of what a provider's retry-after says. */
export const MAX_AVAILABILITY_CHECK_MS = 8_000;

/** Ceiling on retry-after respected from a provider — protects the total budget above even if a provider asks for something absurd. */
const MAX_RETRY_AFTER_MS = 4_000;

/** Backoff schedule for TIMEOUT, in ms — bounded, not exponential-forever. */
const TIMEOUT_BACKOFF_MS = [500, 1_500];

/**
 * Codes that never retry, no matter what the caller passes — a hard-coded
 * list, not merely trusting an IntegrationError.retryable flag, so a
 * mis-set flag on a future adapter can't accidentally create a retry loop
 * on an error that structurally can never succeed on retry (bad
 * credentials, no provider, a business-input problem).
 */
const NEVER_RETRY: ReadonlySet<IntegrationErrorCode> = new Set([
  "NO_PROVIDER",
  "CAPABILITY_NOT_SUPPORTED",
  "MISSING_MAPPING",
  "MISSING_REQUIRED_INPUT",
  "AUTH_ERROR",
  "INVALID_RESPONSE",
]);

export interface RetryDecisionInput {
  code: IntegrationErrorCode;
  retryAfterSeconds?: number;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/**
 * Pure, deterministic retry policy — no network, no timers. `attempt` is
 * 1-indexed (the attempt that just failed); `elapsedMs` is the time already
 * spent on this checkAvailability call, used to enforce
 * MAX_AVAILABILITY_CHECK_MS regardless of what an individual code would
 * otherwise allow.
 */
export function decideRetry(input: RetryDecisionInput, attempt: number, elapsedMs: number): RetryDecision {
  if (NEVER_RETRY.has(input.code)) return { retry: false, delayMs: 0 };

  if (input.code === "RATE_LIMITED") {
    const requested = input.retryAfterSeconds !== undefined ? input.retryAfterSeconds * 1000 : TIMEOUT_BACKOFF_MS[0];
    const delayMs = Math.min(requested, MAX_RETRY_AFTER_MS);
    if (elapsedMs + delayMs > MAX_AVAILABILITY_CHECK_MS) return { retry: false, delayMs: 0 };
    return { retry: true, delayMs };
  }

  if (input.code === "TIMEOUT" || input.code === "PROVIDER_ERROR") {
    if (attempt > TIMEOUT_BACKOFF_MS.length) return { retry: false, delayMs: 0 };
    const delayMs = TIMEOUT_BACKOFF_MS[attempt - 1];
    if (elapsedMs + delayMs > MAX_AVAILABILITY_CHECK_MS) return { retry: false, delayMs: 0 };
    return { retry: true, delayMs };
  }

  return { retry: false, delayMs: 0 };
}
