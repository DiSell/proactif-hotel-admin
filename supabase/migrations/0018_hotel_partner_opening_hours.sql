-- =========================================================================
-- Proactif System — Free-text opening hours for hotel partners.
--
-- Additive only. Does not modify any table/policy/grant from 0001_init.sql
-- through 0017_hotel_partner_consent.sql beyond the new column/grant below.
--
-- Deliberately free text, not a structured day/time-range schema: the
-- chatbot never computes "open right now" from it (see features/rag/prompt.ts's
-- buildPartnerGuidance — it may only ever quote what's entered here verbatim,
-- same "never invent an operational fact" discipline as every other partner
-- field). A future structured version (real open/closed computation) would
-- be a separate, additive migration, not a change to this column's meaning.
--
-- Can be filled two ways: (1) the hotel types it in directly, or generates
-- it from the partner's own website (features/partners/actions.ts::
-- fetchPartnerWebsiteSummary*, null if the site never states hours
-- explicitly); (2) the PARTNER fills or corrects it themselves at the
-- moment they respond to the consent request (features/partners/consentActions.ts::
-- acceptPartnerConsent), when the hotel never had a source to fill it from.
-- =========================================================================

alter table public.hotel_partners
  add column opening_hours text;

alter table public.hotel_partners
  add constraint hotel_partners_opening_hours_length check (opening_hours is null or char_length(opening_hours) <= 300);

comment on column public.hotel_partners.opening_hours is
  'Free-text opening hours, entered by the hotel or by the partner at consent time (e.g. "Lun-Sam 12h-14h, 19h-22h"). Never parsed or computed against the current time — features/rag/prompt.ts quotes it verbatim to the model, which is instructed to never invent hours beyond what is entered here.';

-- Additive to the narrow UPDATE grant service_role already had
-- (0017_hotel_partner_consent.sql) — required so acceptPartnerConsent
-- (public confirmation page, no session) can also record opening_hours when
-- the partner supplies it while accepting.
grant update (opening_hours) on public.hotel_partners to service_role;
