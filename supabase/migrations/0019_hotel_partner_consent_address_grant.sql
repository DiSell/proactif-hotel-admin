-- =========================================================================
-- Proactif System — Let the partner also fill in their address at consent
-- time, same as opening_hours (0018_hotel_partner_opening_hours.sql).
--
-- address itself already exists (0015_hotel_partners.sql) — this migration
-- only ADDS the narrow UPDATE grant service_role needs to write it from the
-- public, session-less confirmation page (features/partners/consentActions.ts::
-- acceptPartnerConsent). Rationale: a partner's own website is sometimes
-- JavaScript-rendered and yields zero extractable text (confirmed case:
-- fetchPartnerWebsiteSummary's crawler never executes JS, same as the
-- hotel's own site-analysis crawler) — when the hotel has no source to fill
-- address/opening_hours from, the partner gets a second chance to supply it
-- themselves while accepting.
-- =========================================================================

grant update (address) on public.hotel_partners to service_role;
