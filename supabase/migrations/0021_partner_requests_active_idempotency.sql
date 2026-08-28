-- =========================================================================
-- Proactif System — partner_requests: DB-level idempotency guarantee before
-- any outbound channel is wired up (WhatsApp/provider come later, not
-- touched here). Additive only. Never modifies the state machine, the RPC
-- signatures, or any status transition rule from 0020_partner_requests.sql.
--
-- MVP rule: a single conversation can have at most ONE active
-- partner_request at a time. "Active" = draft, pending_confirmation,
-- sent_to_partner, or alternative_proposed — the exact same set already
-- used by getActivePartnerRequestForConversation()
-- (features/partnerRequests/queries.ts). A terminal request (accepted,
-- rejected, cancelled) never blocks a new one for the same conversation.
--
-- This closes the TOCTOU window application code alone cannot: two
-- concurrent turns for the same conversation could both read "no active
-- request" before either has committed its INSERT. The unique partial
-- index below makes the second INSERT fail with 23505 — the chatbot layer
-- (features/partnerRequests/chatbotService.ts) then re-reads the active
-- request and reuses it instead of surfacing a technical error (see that
-- file's own comment).
-- =========================================================================

-- =========================================================================
-- A. Explicit pre-check for existing active duplicates. Run BEFORE the
-- index is created so a violation produces a clear, actionable message
-- instead of a bare "could not create unique index" from Postgres itself.
-- Deliberately does NOT delete/merge anything automatically — a human must
-- decide how to resolve any pre-existing duplicate (which should not exist
-- given the chatbot's own single-creation-point design, but this migration
-- must not assume that without checking).
-- =========================================================================

do $$
declare
  v_dupe_conversations integer;
begin
  select count(*) into v_dupe_conversations
  from (
    select hotel_id, conversation_id
    from public.partner_requests
    where status in ('draft', 'pending_confirmation', 'sent_to_partner', 'alternative_proposed')
    group by hotel_id, conversation_id
    having count(*) > 1
  ) as dupes;

  if v_dupe_conversations > 0 then
    raise exception
      'partner_requests: % conversation(s) already have more than one active partner_request (draft/pending_confirmation/sent_to_partner/alternative_proposed). Resolve these manually (cancel/merge as appropriate) before re-running this migration — no automatic deletion or merge is performed.',
      v_dupe_conversations;
  end if;
end
$$;

-- =========================================================================
-- B. The unique partial index itself — IF NOT EXISTS makes this migration
-- safe to re-run (unlike ADD CONSTRAINT, CREATE INDEX supports this
-- directly since PostgreSQL 9.5). Scoped to (hotel_id, conversation_id),
-- not conversation_id alone, purely for defense in depth consistent with
-- every other tenant-scoped check in this schema — conversation_id is
-- already globally unique and tied to exactly one hotel_id via
-- partner_requests_conversation_fk, so this could not itself allow a
-- cross-tenant collision either way.
-- =========================================================================

create unique index if not exists partner_requests_hotel_conversation_active_key
  on public.partner_requests (hotel_id, conversation_id)
  where status in ('draft', 'pending_confirmation', 'sent_to_partner', 'alternative_proposed');

comment on index public.partner_requests_hotel_conversation_active_key is
  'Enforces at most one active (draft/pending_confirmation/sent_to_partner/alternative_proposed) partner_request per conversation. A second create_partner_request() call for the same hotel_id+conversation_id while one is already active fails with SQLSTATE 23505 — see features/partnerRequests/chatbotService.ts, which reads getActivePartnerRequestForConversation() on that specific error and reuses the existing row instead of creating a duplicate. A terminal request (accepted/rejected/cancelled) never counts toward this limit, so a new request can always be started once the previous one is resolved.';
