-- =========================================================================
-- Proactif System — conversation_moderation: automatic abuse flagging
-- (model self-report, per turn) + hotel-admin blocking of a malicious
-- visitor's ongoing widget session. Additive only to conversations
-- (0001_init.sql) — no other table touched.
--
-- Two independent, deliberately simple mechanisms:
--   1. flag_conversation() — called from the chat pipeline itself
--      (features/rag/moderation.ts, service_role) whenever the model's own
--      structured output reports flaggedAsAbusive=true for a turn (see
--      buildHotelInstructions' hostility rules in prompt.ts). Idempotent:
--      only the FIRST flag on a conversation actually changes anything —
--      returns whether THIS call was that first flag, so the caller knows
--      whether to send exactly one notification email, never one per
--      abusive message in a sustained tirade.
--   2. block_conversation()/unblock_conversation() — called by a hotel_admin
--      from /client/conversations/[conversationId] after reviewing a
--      flagged (or any) conversation. A blocked conversation's session can
--      no longer send a message (see the widget chat route's own check on
--      conversations.blocked_at) — the OpenAI call is never even reached,
--      no cost incurred.
--
-- Same session-scoped limitation as the existing rate limiter
-- (0006_widget_rate_limit.sql): blocking targets THIS conversation's own
-- session_id, not an IP or any longer-lived visitor identity (deliberately
-- not tracked anywhere in this codebase) — a visitor who clears their
-- browser storage gets a fresh session and is no longer recognized as
-- blocked. A real, accepted mitigation against an ongoing abusive session,
-- not an absolute guarantee against a determined return visit.
--
-- PROPOSED, NOT YET APPLIED — same convention as every migration since
-- 0001_init.sql: apply it through your own Supabase workflow when ready.
-- =========================================================================

alter table public.conversations
  add column flagged_at timestamptz,
  add column flag_reason text,
  add column blocked_at timestamptz,
  add column blocked_by uuid references public.profiles (id) on delete set null;

comment on column public.conversations.flagged_at is
  'First time the model itself reported flaggedAsAbusive=true for a message in this conversation (see features/rag/moderation.ts). Never cleared automatically — a hotel_admin reviewing the conversation is expected to act (e.g. block it) or otherwise dismiss it manually if this column is ever exposed as clearable in the UI (not built in this pass).';

comment on column public.conversations.flag_reason is
  'Short, neutral, staff-facing description from the model (e.g. "propos insultants", "tentative de contournement des règles") — NEVER the raw abusive text itself (see prompt.ts''s own instruction to the model on this). Set once, on the first flag only; later flags on the same conversation never overwrite it.';

comment on column public.conversations.blocked_at is
  'Set by block_conversation() (hotel_admin/superadmin only). While set, the widget chat route refuses any further message on this conversation before ever reaching answerQuestion() — no OpenAI call, no cost. Cleared by unblock_conversation().';

-- =========================================================================
-- flag_conversation — the ONLY way flagged_at/flag_reason are ever written.
-- SECURITY DEFINER so the chat pipeline's service_role call and a possible
-- future authenticated caller both go through the same authorization
-- check, mirroring every other write function in this codebase.
-- =========================================================================

create or replace function public.flag_conversation(
  p_hotel_id uuid,
  p_conversation_id uuid,
  p_reason text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_already_flagged boolean;
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

  select (flagged_at is not null) into v_already_flagged
  from public.conversations
  where id = p_conversation_id and hotel_id = p_hotel_id
  for update;

  if v_already_flagged is null then
    raise exception 'conversation not found for this hotel' using errcode = 'P0002';
  end if;

  update public.conversations
  set flagged_at = coalesce(flagged_at, now()),
      flag_reason = coalesce(flag_reason, p_reason)
  where id = p_conversation_id;

  -- true exactly when THIS call performed the first-ever flag — the
  -- caller (features/rag/moderation.ts) uses this, not a separate lookup,
  -- to decide whether to send the one-time notification email.
  return not v_already_flagged;
end;
$$;

revoke execute on function public.flag_conversation(uuid, uuid, text) from public;
revoke execute on function public.flag_conversation(uuid, uuid, text) from anon;
grant execute on function public.flag_conversation(uuid, uuid, text) to authenticated, service_role;

-- =========================================================================
-- block_conversation / unblock_conversation — the ONLY way blocked_at/
-- blocked_by are ever written. Never callable by service_role in practice
-- (no chat-pipeline code ever blocks a conversation on its own — only a
-- human decision does), but service_role is still authorized for
-- consistency with every other function's caller-authorization shape in
-- this codebase.
-- =========================================================================

create or replace function public.block_conversation(
  p_hotel_id uuid,
  p_conversation_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
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

  update public.conversations
  set blocked_at = now(), blocked_by = auth.uid()
  where id = p_conversation_id and hotel_id = p_hotel_id;

  if not found then
    raise exception 'conversation not found for this hotel' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.block_conversation(uuid, uuid) from public;
revoke execute on function public.block_conversation(uuid, uuid) from anon;
grant execute on function public.block_conversation(uuid, uuid) to authenticated, service_role;

create or replace function public.unblock_conversation(
  p_hotel_id uuid,
  p_conversation_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
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

  update public.conversations
  set blocked_at = null, blocked_by = null
  where id = p_conversation_id and hotel_id = p_hotel_id;

  if not found then
    raise exception 'conversation not found for this hotel' using errcode = 'P0002';
  end if;
end;
$$;

revoke execute on function public.unblock_conversation(uuid, uuid) from public;
revoke execute on function public.unblock_conversation(uuid, uuid) from anon;
grant execute on function public.unblock_conversation(uuid, uuid) to authenticated, service_role;
