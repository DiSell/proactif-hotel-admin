/**
 * Domain-agnostic "did the visitor just say yes" check — extracted out of
 * partnerRequestFlow.ts (which re-exports it, so its own existing test file
 * keeps working unchanged) so features/rag/spaBookingFlow.ts can use it
 * without importing the entire partner-request module tree for one pure
 * function.
 *
 * Server-side safety net on top of the model's own confirm* structured
 * field — "pas de confirmation implicite" must hold structurally, not only
 * via prompting (same discipline as answer.ts never trusting a raw
 * recommendedAccommodationTypeId/recommendedPartnerIds without independent
 * validation). A model that mis-fires confirmPartnerRequest/confirmSpaBooking
 * = true on an ambiguous reply is still blocked here unless the visitor's
 * own message plausibly contains an explicit affirmative.
 */
const EXPLICIT_CONFIRMATION_PATTERNS: RegExp[] = [
  /\boui\b/i,
  /\byes\b/i,
  /\bje\s+confirme\b/i,
  /\bd['’]accord\b/i,
  /\ballez-y\b/i,
  /\benvoyez\b/i,
  /\bconfirm[ée]?\b/i,
  /\bok\b/i,
  /\bc['’]est\s+bon\b/i,
];

export function isExplicitConfirmation(message: string): boolean {
  return EXPLICIT_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Same server-side safety-net posture as isExplicitConfirmation above, for
 * the negative case — added for the partner-alternative flow
 * (partnerRequestFlow.ts's own alternative_proposed branch), which must
 * never let the model infer a "non" from ambiguous phrasing before calling
 * guest_reject_alternative (a real, hard-to-undo state transition —
 * alternative_proposed -> cancelled, a terminal status).
 */
const EXPLICIT_DENIAL_PATTERNS: RegExp[] = [/\bnon\b/i, /\bno\b/i, /\bje\s+refuse\b/i, /\bpas\s+d['’]accord\b/i, /\bannul[ée]?z?\b/i];

export function isExplicitDenial(message: string): boolean {
  return EXPLICIT_DENIAL_PATTERNS.some((pattern) => pattern.test(message));
}
