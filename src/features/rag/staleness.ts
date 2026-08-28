/**
 * How the app decides "is this knowledge too old to trust for a volatile
 * fact (hours, price, menu, promotion...) without hedging" — see
 * prompt.ts's freshness rule and features/knowledge/StalenessBanner.tsx,
 * which both import this so the threshold can never silently diverge
 * between the chatbot's own reasoning and what the back-office shows an
 * admin.
 *
 * MVP value, not calibrated against real data (unlike
 * retrieve.ts's DEFAULT_SIMILARITY_THRESHOLD) — a week is a reasonable
 * first guess for how fast a hotel's hours/prices/promotions plausibly
 * change. Revisit if real usage shows it's too aggressive or too lax.
 */
export const VOLATILE_STALENESS_DAYS = 7;

/** Whole days elapsed between `iso` and `now` — null when `iso` itself is null (never fabricated). */
export function daysSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const elapsedMs = now.getTime() - new Date(iso).getTime();
  return Math.floor(elapsedMs / (24 * 60 * 60 * 1000));
}

/** A null `iso` (never synced) is never considered "stale" by this function — that's a distinct "no data" state, handled separately by callers (e.g. StalenessBanner's own "Base de connaissances vide" case). */
export function isStale(iso: string | null, days: number = VOLATILE_STALENESS_DAYS, now?: Date): boolean {
  const elapsed = daysSince(iso, now);
  return elapsed !== null && elapsed > days;
}
