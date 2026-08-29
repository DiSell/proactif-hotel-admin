import type { EmbeddedSignupFinishEvent, EmbeddedSignupMessage } from "./types";

/**
 * The origin Meta's Embedded Signup popup posts its result message from —
 * commonly documented across Meta's Facebook Login for Business postMessage
 * flows as https://www.facebook.com. NOT independently re-confirmed against
 * a live popup during this task (no real Meta interaction was performed —
 * see this task's own explicit prohibition). Re-verify this exact value
 * against a real (test-mode) Embedded Signup session before relying on it
 * in production; a wrong origin here silently drops every legitimate
 * message (fails closed, never open).
 */
export const META_EMBEDDED_SIGNUP_ORIGIN = "https://www.facebook.com";

const FINISH_EVENTS: readonly EmbeddedSignupFinishEvent[] = [
  "FINISH",
  "FINISH_ONLY_WABA",
  "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  "FINISH_OBO_MIGRATION",
  "FINISH_GRANT_ONLY_API_ACCESS",
];

/**
 * Parses ONE window `message` event into a structured EmbeddedSignupMessage
 * — returns null for anything that isn't a genuine, well-formed Embedded
 * Signup message: wrong origin, non-JSON/non-object payload, wrong `type`,
 * or an unrecognized `event` name. Never guesses at a shape it doesn't
 * recognize (same "never guessed at" discipline as
 * lib/notifications/whatsapp/metaProvider.ts's own extractInboundEvents).
 *
 * The ids extracted here (wabaId/phoneNumberId/businessId) are for DISPLAY
 * ONLY — never trusted as the basis for a server-side write. A real
 * connection is only ever confirmed by the server's OWN exchange with Meta
 * (not implemented in this task — see actions.ts).
 */
export function parseEmbeddedSignupMessage(event: Pick<MessageEvent, "origin" | "data">, expectedOrigin: string): EmbeddedSignupMessage | null {
  if (event.origin !== expectedOrigin) return null;

  let data: unknown;
  try {
    data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;

  const record = data as Record<string, unknown>;
  if (record.type !== "WA_EMBEDDED_SIGNUP") return null;

  const eventName = record.event;
  const innerData = (typeof record.data === "object" && record.data !== null ? record.data : {}) as Record<string, unknown>;

  if (eventName === "CANCEL") {
    return { event: "CANCEL", currentStep: typeof innerData.current_step === "string" ? innerData.current_step : null };
  }
  if (eventName === "ERROR") {
    return { event: "ERROR" };
  }
  if (typeof eventName === "string" && (FINISH_EVENTS as readonly string[]).includes(eventName)) {
    return {
      event: eventName as EmbeddedSignupFinishEvent,
      wabaId: typeof innerData.waba_id === "string" ? innerData.waba_id : null,
      phoneNumberId: typeof innerData.phone_number_id === "string" ? innerData.phone_number_id : null,
      businessId: typeof innerData.business_id === "string" ? innerData.business_id : null,
    };
  }

  return null;
}

/**
 * The ONLY finish event this codebase currently treats as safe to surface
 * as "connexion Meta validée — finalisation requise" (task section 17) —
 * FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING is Meta's own documented
 * coexistence path: the existing WhatsApp Business App number keeps
 * working on the phone AND becomes usable via the Cloud API, no
 * deregistration involved. Plain FINISH (a fresh WABA/number with no prior
 * app registration) is also safe by construction — there's nothing to
 * coexist with. FINISH_ONLY_WABA / FINISH_GRANT_ONLY_API_ACCESS are
 * narrower, also non-destructive grants.
 *
 * FINISH_OBO_MIGRATION is deliberately EXCLUDED: "on-behalf-of migration"
 * could not be confirmed as non-destructive to an existing WhatsApp
 * Business App registration from documentation available during this
 * task's audit — see this file's own header comment. Surfacing it as a
 * plain "finalisation requise" success state would risk silently
 * continuing into a destructive migration path, which the task explicitly
 * forbids. isSafeFinishEvent() returning false for it is what routes the
 * UI to the "unsupported_flow" stop state instead (EmbeddedSignupButton.tsx).
 */
export function isSafeFinishEvent(event: EmbeddedSignupFinishEvent): boolean {
  return event !== "FINISH_OBO_MIGRATION";
}

export type EmbeddedSignupOutcome =
  | { status: "awaiting_finalization"; event: EmbeddedSignupFinishEvent; wabaId: string | null; phoneNumberId: string | null; businessId: string | null }
  | { status: "cancelled" }
  | { status: "error" }
  | { status: "unsupported_flow" };

/**
 * Pure decision function combining the two INDEPENDENT channels Meta uses
 * (confirmed by documentation): the `code` comes from the FB.login()
 * JavaScript callback's own `response.authResponse.code` — NEVER from the
 * postMessage — while the postMessage (`WA_EMBEDDED_SIGNUP`) carries the
 * event classification (FINISH.../CANCEL/ERROR) and the waba/phone/business
 * ids. EmbeddedSignupButton.tsx wires both channels to this function;
 * everything here is DOM-free and directly unit-testable.
 *
 * A safe FINISH event without a code (or vice versa) is treated as `error`
 * — the two channels are expected to agree; a mismatch is never guessed
 * at or silently resolved in either direction.
 */
export function classifyEmbeddedSignupOutcome(message: EmbeddedSignupMessage | null, hasCode: boolean): EmbeddedSignupOutcome {
  if (message) {
    if (message.event === "CANCEL") return { status: "cancelled" };
    if (message.event === "ERROR") return { status: "error" };
    if (!isSafeFinishEvent(message.event)) return { status: "unsupported_flow" };
    if (!hasCode) return { status: "error" };
    return {
      status: "awaiting_finalization",
      event: message.event,
      wabaId: message.wabaId,
      phoneNumberId: message.phoneNumberId,
      businessId: message.businessId,
    };
  }
  return hasCode ? { status: "error" } : { status: "cancelled" };
}
