/**
 * Persists "a booking/stay conversation is genuinely engaged" across turns
 * for the generic "Réserver" CTA (see answer.ts's bookingIntentDetected and
 * buildBookingAction) — mirrors spaBookingFlow.ts's own SPA_RECAP_MARKER /
 * lastAssistantMessageContinuesSpaBooking / withSpaContinuationMarker
 * mechanism exactly, applied to a different domain. A different invisible
 * character than the spa marker, deliberately: the two domains stay
 * structurally independent, same precedent as this codebase's own
 * reply-token duplication between partner requests and spa bookings.
 *
 * Fixes a real, observed bug: isBookingIntent(message) (bookingCta-adjacent
 * detection in answer.ts) only ever looked at the CURRENT message's own
 * keywords ("réserver", "disponible", ...). A visitor who said "je veux
 * réserver une chambre" (intent detected, CTA shown) and then, on the very
 * next turn, supplied exactly what the assistant had just asked for
 * ("20/09 au 22/09 2 personnes" — no booking keyword at all) saw the
 * Réserver button silently disappear, right when it was most useful.
 *
 * Deliberately NOT gated on shouldResolveStayContext or any other keyword
 * re-check on the CONTINUATION side: once a real, keyword-matched intent has
 * fired at least once in this conversation, the CTA stays available for the
 * rest of it — the marker alone decides continuation, so a later turn
 * phrased without any recognizable keyword (dates, "oui", a bare name)
 * never loses the button again. This is also what correctly keeps a PURELY
 * documentary conversation ("la Suite Deluxe a la clim ?" -> "et pour 2
 * personnes ?") from ever showing the CTA: the marker is only ever written
 * following a genuine isBookingIntent match (see answer.ts's own
 * withBookingIntentMarker call sites), so a conversation that never said
 * anything matching those keywords never sets it in the first place —
 * continuation is never inferred from keywords alone, only from this marker.
 */

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

/** 8x U+2064 INVISIBLE PLUS — zero-width in every renderer, unlike an HTML comment or bracketed tag. Distinct from spaBookingFlow.ts's own marker character on purpose. */
const BOOKING_INTENT_MARKER = "⁤".repeat(8);

/**
 * Finds the MOST RECENT assistant message in history and checks whether it
 * carries the marker. `history` here is exactly answer.ts's own
 * `historyInput` (loaded via loadHistory AFTER the current user message was
 * already persisted — see answer.ts::answerQuestion), so the current turn's
 * own message is always the last entry and is naturally skipped by scanning
 * backwards for the first "assistant" role.
 */
export function lastAssistantMessageIndicatesBookingIntent(history: HistoryMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content.includes(BOOKING_INTENT_MARKER);
  }
  return false;
}

/** Appends the invisible continuation marker — the ONLY place it's ever written. */
export function withBookingIntentMarker(reply: string): string {
  return `${reply}\n${BOOKING_INTENT_MARKER}`;
}
