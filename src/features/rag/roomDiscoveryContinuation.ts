/**
 * Persists "a room-discovery conversation is genuinely engaged" across turns
 * — mirrors bookingIntentContinuation.ts / spaBookingFlow.ts's own marker
 * mechanism exactly, applied to this third domain. A different invisible
 * character than either of those two, deliberately: the three domains stay
 * structurally independent (see bookingIntentContinuation.ts's own doc
 * comment for why).
 *
 * Fixes a real, confirmed bug (stress test, CAS A): isRoomDiscoveryIntent(message)
 * only ever looks at the CURRENT message's own keywords. A visitor who said
 * "montre-moi les chambres" (intent detected, "combien de personnes ?" asked)
 * and then, on the very next turn, answered with EXACTLY what was asked for
 * ("2" — no discovery verb, no room noun, nothing isRoomDiscoveryIntent could
 * ever recognize on its own) fell through every gate: neither
 * isRoomDiscoveryIntent nor shouldResolveStayContext fired, so party stayed
 * unresolved and the visitor's answer was effectively dropped.
 *
 * Deliberately NOT gated on any keyword re-check on the continuation side —
 * once a real match has fired at least once, the flow stays "live" for the
 * rest of the conversation, the marker alone decides continuation (same
 * discipline as the other two markers). The one exception, handled at the
 * call site in answer.ts (not here): a FRESH, explicit isBookingIntent match
 * on the current message overrides a stale continuation signal, so "je veux
 * réserver" always reactivates booking even after a discovery detour —
 * mirrors the existing spaBookingCandidateActive/partnerRequestFlowActive
 * precedence-by-short-circuit pattern already in answer.ts, not a new state
 * machine.
 */

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** 8x U+2062 INVISIBLE TIMES — zero-width in every renderer. Distinct from bookingIntentContinuation.ts's (U+2064) and spaBookingFlow.ts's (U+2063) own markers. */
const ROOM_DISCOVERY_MARKER = "⁢".repeat(8);

/**
 * Finds the MOST RECENT assistant message in history and checks whether it
 * carries the marker — same scan-backwards discipline as the other two
 * markers (see bookingIntentContinuation.ts's own doc comment on why this
 * naturally skips the current turn's own message).
 */
export function lastAssistantMessageIndicatesRoomDiscoveryContinuation(history: HistoryMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content.includes(ROOM_DISCOVERY_MARKER);
  }
  return false;
}

/** Appends the invisible continuation marker — the ONLY place it's ever written. */
export function withRoomDiscoveryMarker(reply: string): string {
  return `${reply}\n${ROOM_DISCOVERY_MARKER}`;
}
