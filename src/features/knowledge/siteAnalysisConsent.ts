/**
 * The exact consent copy shown before the very first site-analysis run for
 * a given (hotel, domain) pair, and the version tag recorded — alongside a
 * verbatim copy of the text itself — in site_analysis_consents (see
 * supabase/migrations/0003_site_analysis_consent.sql — PROPOSED, not yet
 * applied).
 *
 * Bump CURRENT_CONSENT_VERSION whenever the wording changes. This never
 * touches, deletes, or overwrites a previously recorded consent row — it
 * only changes what hasSiteAnalysisConsent() checks FOR going forward, so
 * an older version's row simply stops satisfying that check, while
 * remaining on record exactly as it was confirmed.
 *
 * This consent is a permission gate only. It never overrides robots.txt or
 * the SSRF guard (features/crawler/networkGuard.ts, robots.ts) — both are
 * still enforced on every crawl regardless of what's recorded here — and
 * it never authorizes any domain other than the exact one confirmed, which
 * the route itself has already verified is the establishment's own
 * hotels.website domain (see the analyze route) before this is even
 * checked.
 */
export const CURRENT_CONSENT_VERSION = "2026-08-22";

export const SITE_ANALYSIS_CONSENT_TEXT =
  "Je confirme être autorisé à faire analyser ce site par Proactif System afin d’en extraire les informations nécessaires à la création et au fonctionnement de l’assistant.";
