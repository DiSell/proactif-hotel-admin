import { extractPartySize } from "../rag/partySize";

/**
 * Two DISTINCT gates, deliberately not merged into one:
 *
 * - shouldResolveStayContext: broad — "is it worth reconstructing a
 *   StayRequestState?" True for party size, ages, dates, stay-length
 *   mentions, even with no availability intent at all. Feeds
 *   accommodationRanking (capacity) regardless of whether a real
 *   availability check will ever run.
 * - isAvailabilityRequest: narrow — "should checkAvailability actually be
 *   called?" Only true for an explicit request to check/book, so a
 *   business-only recommendation question ("quelle chambre nous
 *   conseillez-vous ?") never produces a spurious "je ne peux pas vérifier
 *   la disponibilité" aside.
 *
 * Both are COST/ROUTING OPTIMIZATIONS ONLY, never business rules — a false
 * negative degrades gracefully (no stay context / no availability attempt
 * this turn), it never blocks or errors.
 */

const AVAILABILITY_PATTERNS: RegExp[] = [
  /disponib/i, // disponible, disponibilité
  /\blibres?\b/i, // "chambres libres"
  /r[ée]serv/i, // réserver, réservation
  /\bqu['’]?avez[- ]vous\b/i,
  /\bavez[- ]vous\b/i,
  /\bvacan(?:c|t)/i,
  /\bavailable\b/i,
  /\bbook(?:ing)?\b/i,
];

/**
 * TODO(Phase C): once a real provider is connected, a false negative here
 * genuinely prevents a check that could have succeeded — that's only
 * acceptable today because checkAvailability always resolves to
 * NO_PROVIDER anyway (see resolver.ts), so nothing real is ever missed.
 * Revisit this heuristic (or replace it with a model-driven intent check)
 * before the first real AvailabilityProvider goes live.
 */
export function isAvailabilityRequest(message: string): boolean {
  return AVAILABILITY_PATTERNS.some((pattern) => pattern.test(message));
}

const STAY_CONTEXT_PATTERNS: RegExp[] = [
  /\bjanvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre\b/i,
  /\bjanuary|february|march|april|may|june|july|august|september|october|november|december\b/i,
  /\bdemain\b/i,
  /\btomorrow\b/i,
  /\bce week-?end\b/i,
  /\bthis weekend\b/i,
  /\bnuits?\b/i,
  /\bnights?\b/i,
  /\bs[ée]jour\b/i,
  /\bstay\b/i,
  /\b\d{1,2}\s*ans?\b/i, // e.g. "8 ans" (child age)
  /\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?/, // date-shaped, e.g. 12/09 or 12-09-2026
];

export function shouldResolveStayContext(message: string): boolean {
  if (isAvailabilityRequest(message)) return true;
  if (extractPartySize(message).total !== null) return true;
  return STAY_CONTEXT_PATTERNS.some((pattern) => pattern.test(message));
}
