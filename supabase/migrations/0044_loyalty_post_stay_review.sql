-- Proactif System — Phase 1 "suivi après séjour": remerciement et demande
-- d'avis, configurables indépendamment par l'hôtelier. Extends
-- loyalty_settings (0037_customer_loyalty.sql) only — no other table
-- touched, no existing row's current behavior changed.
--
-- subject/content already ARE the "remerciement" block's objet/message
-- (used unconditionally for every post_stay send today) — reused as-is
-- rather than renamed, so no data migration is needed for them.
--
-- Retrocompatibility: every existing row gets thank_you_enabled = true and
-- review_enabled = false, i.e. exactly today's behavior (a post_stay send
-- always carries subject/content, never a review block) — an existing
-- hotel's follow-up keeps working unchanged after this migration.
--
-- Legal note (not decided by this migration): qualifying the post_stay flow
-- (thank-you + review request, still gated only by customer_unsubscribed/
-- hotel_excluded — never by marketing_allowed, see eligibility.ts's
-- evaluatePostStayEligibility, unchanged here) against electronic-
-- prospecting rules is a product/legal question to validate before real
-- production use, not something this repository asserts.

alter table public.loyalty_settings
  add column thank_you_enabled boolean not null default true,
  add column review_enabled boolean not null default false,
  add column review_content text not null default 'Votre avis nous serait précieux.',
  add column review_url text,
  add column review_button_label text not null default 'Laisser un avis';

alter table public.loyalty_settings
  add constraint loyalty_settings_review_url_required_when_enabled
    check (review_enabled = false or review_url is not null),
  add constraint loyalty_settings_at_least_one_block
    check (thank_you_enabled or review_enabled);
