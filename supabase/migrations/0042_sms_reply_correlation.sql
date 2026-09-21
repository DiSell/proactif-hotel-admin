-- =========================================================================
-- Proactif System — sms_reply_correlation: adds a dedicated, opaque
-- SMS reply-code correlation column to partner_request_deliveries
-- (0023_partner_request_deliveries.sql) and spa_booking_deliveries
-- (0035_spa_booking_approval.sql), for the Twilio SMS transport
-- (src/lib/notifications/sms/, PHASE 1 already shipped and inactive).
--
-- WHY A NEW, DEDICATED COLUMN (not a reuse of accept_reply_token_hash /
-- reject_reply_token_hash / propose_alternative_token_hash): those three
-- columns each correspond to ONE WhatsApp quick-reply button — a WhatsApp
-- delivery attempt gets three independent random tokens, one per button,
-- because Meta's Cloud API returns the exact button payload tapped and
-- nothing else. An inbound SMS carries no such per-button distinction — a
-- single free-text Body ("1 K7M4PZ", "3 K7M4PZ 21h00") always starts with
-- the digit the recipient typed, which alone determines the command; the
-- CODE's only job is to identify WHICH delivery the reply is about. One
-- opaque code per delivery is therefore both sufficient and semantically
-- correct — reusing e.g. accept_reply_token_hash to hold this one shared
-- code would misrepresent what that column means (audited and explicitly
-- rejected this session: "aucune réutilisation de accept_reply_token_hash").
--
-- WHY A NEW SIBLING FUNCTION, NOT AN EXTRA PARAMETER ON
-- start_partner_request_delivery()/start_spa_booking_delivery(): adding a
-- trailing parameter (even with a DEFAULT) changes a Postgres function's
-- argument-type signature, so CREATE OR REPLACE FUNCTION would not replace
-- the existing function in place — it would silently create a SEPARATE,
-- additional overload, leaving two same-named functions with diverging
-- bodies. A distinctly-named sibling function
-- (start_partner_request_delivery_sms / start_spa_booking_delivery_sms)
-- is unambiguous to call, leaves the existing functions byte-for-byte
-- untouched (not even a new overload of them), and satisfies "les appels
-- WhatsApp existants doivent continuer à fonctionner sans modification de
-- comportement" as a structural guarantee, not just a testing claim.
--
-- Does NOT touch 0023/0035 directly — additive ALTER/CREATE only, same
-- discipline every migration in this repo already follows for extending an
-- earlier one without editing it.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

-- =========================================================================
-- A. partner_request_deliveries.sms_reply_code_hash
-- =========================================================================

alter table public.partner_request_deliveries
  add column sms_reply_code_hash text;

comment on column public.partner_request_deliveries.sms_reply_code_hash is
  'SHA-256 hash of the single opaque SMS reply code for THIS delivery attempt (see lib/notifications/sms/smsReplyCode.ts) — the raw code itself is NEVER stored. Unlike accept_reply_token_hash/reject_reply_token_hash/propose_alternative_token_hash (one WhatsApp button each), a single code identifies the delivery; the digit typed alongside it (1/2/3) in the inbound SMS Body selects the command. NULL for every WhatsApp delivery row (provider = ''meta'').';

-- Same "at most one active row per code" guarantee as the WhatsApp hash
-- columns' own unique indexes — a partial unique index so historical
-- NULL values (every pre-existing WhatsApp row) never collide with each
-- other or block a new SMS code.
create unique index partner_request_deliveries_sms_reply_code_hash_key
  on public.partner_request_deliveries (sms_reply_code_hash)
  where sms_reply_code_hash is not null;

-- =========================================================================
-- B. spa_booking_deliveries.sms_reply_code_hash — same reasoning as A.
-- =========================================================================

alter table public.spa_booking_deliveries
  add column sms_reply_code_hash text;

comment on column public.spa_booking_deliveries.sms_reply_code_hash is
  'SHA-256 hash of the single opaque SMS reply code for THIS delivery attempt (see lib/notifications/sms/smsReplyCode.ts) — the raw code itself is NEVER stored. NULL for every WhatsApp delivery row (provider = ''meta'').';

create unique index spa_booking_deliveries_sms_reply_code_hash_key
  on public.spa_booking_deliveries (sms_reply_code_hash)
  where sms_reply_code_hash is not null;

-- =========================================================================
-- C. start_partner_request_delivery_sms — mirrors
-- start_partner_request_delivery (0023) exactly (same auth check, same row
-- lock, same queued -> sending guard), but sets ONLY sms_reply_code_hash;
-- the three WhatsApp-specific hash columns stay NULL on an SMS delivery
-- row, same as sms_reply_code_hash stays NULL on a WhatsApp delivery row.
-- =========================================================================

create or replace function public.start_partner_request_delivery_sms(
  p_delivery_id uuid,
  p_hotel_id uuid,
  p_sms_reply_code_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select status into v_status
  from public.partner_request_deliveries
  where id = p_delivery_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'partner_request_delivery not found for this hotel' using errcode = 'P0002';
  end if;
  if v_status <> 'queued' then
    raise exception 'delivery not in queued status (found %)', v_status using errcode = 'P0001';
  end if;

  update public.partner_request_deliveries
  set status = 'sending',
      sms_reply_code_hash = p_sms_reply_code_hash
  where id = p_delivery_id;
end;
$$;

revoke execute on function public.start_partner_request_delivery_sms(uuid, uuid, text) from public;
revoke execute on function public.start_partner_request_delivery_sms(uuid, uuid, text) from anon;
grant execute on function public.start_partner_request_delivery_sms(uuid, uuid, text) to authenticated, service_role;

-- =========================================================================
-- D. start_spa_booking_delivery_sms — mirrors start_spa_booking_delivery
-- (0035) exactly, same reasoning as C.
-- =========================================================================

create or replace function public.start_spa_booking_delivery_sms(
  p_delivery_id uuid,
  p_hotel_id uuid,
  p_sms_reply_code_hash text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if (auth.jwt() ->> 'role') = 'service_role' then
    null;
  elsif public.is_superadmin() then
    null;
  elsif public.is_hotel_admin_for(p_hotel_id) then
    null;
  else
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select status into v_status
  from public.spa_booking_deliveries
  where id = p_delivery_id and hotel_id = p_hotel_id
  for update;

  if v_status is null then
    raise exception 'spa_booking_delivery not found for this hotel' using errcode = 'P0002';
  end if;
  if v_status <> 'queued' then
    raise exception 'delivery not in queued status (found %)', v_status using errcode = 'P0001';
  end if;

  update public.spa_booking_deliveries
  set status = 'sending',
      sms_reply_code_hash = p_sms_reply_code_hash
  where id = p_delivery_id;
end;
$$;

revoke execute on function public.start_spa_booking_delivery_sms(uuid, uuid, text) from public;
revoke execute on function public.start_spa_booking_delivery_sms(uuid, uuid, text) from anon;
grant execute on function public.start_spa_booking_delivery_sms(uuid, uuid, text) to authenticated, service_role;
