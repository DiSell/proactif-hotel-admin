-- =========================================================================
-- Proactif System — minimal service_role permissions for the public widget.
--
-- Additive only — no change to 0001_init.sql through 0008 (their table
-- shapes, RLS policies, and existing grants to anon/authenticated are
-- untouched). NEVER modify or replay 0001-0008.
--
-- PROPOSED, NOT YET APPLIED. Apply it through your own Supabase workflow
-- (dashboard SQL editor / `supabase db push`) when ready — nothing in this
-- codebase executes migrations automatically.
--
-- ROOT CAUSE this migration fixes: every public-widget code path
-- (src/features/widget/publicHotel.ts, src/app/api/widget/[widgetKey]/
-- chat|config/route.ts, src/features/rag/answer.ts, src/features/rag/
-- retrieve.ts) uses the service-role client (createAdminClient()).
-- service_role has BYPASSRLS, so it never hits an RLS policy — but
-- BYPASSRLS only bypasses row-security POLICIES, not the separate Postgres
-- GRANT/REVOKE privilege system. Every table/function in this project was
-- only ever granted to `authenticated` (the admin dashboard's role) and
-- explicitly revoked from `anon` (see 0001/0002/0004's "Data API grants"
-- sections) — service_role was never mentioned at all, so it has zero
-- privileges on any of them by default. Confirmed live: querying
-- public.hotels as service_role fails with 42501 "permission denied for
-- table hotels".
--
-- Least privilege: this migration grants ONLY what the widget code path
-- actually executes, verified by reading the source below (not assumed).
-- No `grant all`, no `alter default privileges` (so a future table created
-- by a later migration gets NOTHING for service_role until an explicit
-- grant is added for it, same discipline already used for authenticated),
-- no grant to anon/authenticated, no RLS change, no access to
-- profiles/hotel_integrations/booking_quotes/reservation_operations/
-- reservation_audit_log or anything outside the widget's real path.
-- =========================================================================

-- =========================================================================
-- 1) Tables read directly by the widget path — SELECT only
-- =========================================================================
-- hotels: resolvePublicWidgetContext (publicHotel.ts:74, .select("*").eq
-- ("widget_key", ...)) and answerQuestion (answer.ts:147-151, .select("*")
-- .eq("id", hotelId)). Never inserted/updated/deleted by this path.
grant select on public.hotels to service_role;

-- chatbot_settings: answerQuestion (answer.ts:156-160, .select("*")). Read
-- only — never written by the widget path (admin dashboard writes it via
-- the authenticated client, unaffected by this migration).
grant select on public.chatbot_settings to service_role;

-- widget_settings: resolvePublicWidgetContext (publicHotel.ts:81-85,
-- .select("*")). Read only.
grant select on public.widget_settings to service_role;

-- accommodation_types: answerQuestion (answer.ts:195-200, .select("*")
-- .eq("hotel_id", ...).eq("active", true)). Read only.
grant select on public.accommodation_types to service_role;

-- room_photos: buildRoomRecommendation (answer.ts:317-322, .select
-- ("photo_url, alt_text")). Read only.
grant select on public.room_photos to service_role;

-- knowledge_chunks / knowledge_sources: NOT queried directly by any
-- TypeScript in the widget path — but match_knowledge_chunks() (defined in
-- 0002_rag.sql) is `security invoker`, and its body (0002_rag.sql:198-211)
-- selects from knowledge_chunks AND joins knowledge_sources. A SECURITY
-- INVOKER function runs with the CALLER's privileges, so service_role
-- (calling it via retrieveKnowledge -> supabase.rpc("match_knowledge_chunks",
-- ...), retrieve.ts:78-82) needs SELECT on both tables for the function's
-- own query to succeed — confirmed by reading 0002's SQL body, not assumed.
-- knowledge_sources was not in the originally-suspected list; it is
-- required for the exact same reason knowledge_chunks is (the join).
grant select on public.knowledge_chunks to service_role;
grant select on public.knowledge_sources to service_role;

-- =========================================================================
-- 2) conversations — SELECT, INSERT, UPDATE (no DELETE)
-- =========================================================================
-- SELECT: chat route's ownership lookup (route.ts:169-174, .select("id,
-- session_id").eq("id", ...).eq("hotel_id", ...)).
-- INSERT: chat route's new-conversation creation (route.ts:202-206,
-- .insert({hotel_id, session_id}).select("id").single() — the trailing
-- .select() after insert also needs SELECT, already granted above).
-- UPDATE: answerQuestion's last_message_at bump (answer.ts:173,
-- .update({last_message_at}).eq("id", ...).eq("hotel_id", ...)).
-- Never deleted by this path.
grant select, insert, update on public.conversations to service_role;

-- =========================================================================
-- 3) messages — SELECT, INSERT (no UPDATE, no DELETE)
-- =========================================================================
-- SELECT: chat route's message-count cap (route.ts:187-191, count query)
-- and answerQuestion's loadHistory (answer.ts:548-553).
-- INSERT: the visitor's message (answer.ts:162-164) and every assistant
-- reply via insertAssistantMessage (answer.ts:570-584, .insert({...})
-- .select("id").single() — again needs SELECT, already granted above).
-- Never updated or deleted by this path.
grant select, insert on public.messages to service_role;

-- =========================================================================
-- 4) message_sources — INSERT only (deliberately NOT SELECT)
-- =========================================================================
-- answerGrounded inserts source rows (answer.ts:441-448,
-- `await supabase.from("message_sources").insert(sourceRows)`) with no
-- `.select()` chained — PostgREST only needs INSERT to perform a bare
-- insert; SELECT is only required when a response representation of the
-- written row is requested (see conversations/messages above, where
-- `.select()` IS chained). Nothing else in the widget path reads
-- message_sources back (the admin-only SourcesDebugPanel reads it through
-- the session-bound authenticated client, never through service_role).
-- Granting SELECT here would be an unused privilege, not something this
-- code path exercises.
grant insert on public.message_sources to service_role;

-- =========================================================================
-- 5) RPCs
-- =========================================================================
-- match_knowledge_chunks(uuid, vector, integer) — retrieveKnowledge
-- (retrieve.ts:78-82). Stays SECURITY INVOKER (0002_rag.sql, unchanged
-- here) — that's why #1 above also grants SELECT on its two underlying
-- tables. EXECUTE alone would not be enough for an invoker function.
grant execute on function public.match_knowledge_chunks(uuid, vector, integer) to service_role;

-- widget_rate_limit_try_consume(text, integer, integer) — checkWidget
-- GlobalRateLimit / checkWidgetSessionRateLimit (rateLimit.ts), called on
-- every chat request (route.ts:112, route.ts:151).
--
-- DECISION — SECURITY DEFINER (not INVOKER) for this one function, chosen
-- deliberately for the smaller privilege surface, unlike
-- match_knowledge_chunks above:
--
--   Option A (INVOKER, matching how the function is defined today in
--   0006/0007/0008): would require granting service_role SELECT, INSERT,
--   AND DELETE directly on widget_rate_limit_buckets (the function's body
--   does all three — see 0008's DELETE + INSERT ... ON CONFLICT). That
--   hands service_role standing, unmediated read/write access to the raw
--   counter table itself: any other code path that ever reuses the
--   service-role client (now or in a future change) could read or mutate
--   rate-limit counters directly, bypassing the function's atomicity and
--   its parameter validation entirely.
--
--   Option B (DEFINER, chosen here): the function runs as its OWNER (the
--   role that ran 0006's `create function`, with its own pre-existing full
--   access to every table it created) instead of as the caller.
--   service_role then needs only EXECUTE on the function — zero standing
--   privileges on widget_rate_limit_buckets itself. The table stays
--   reachable exclusively through this one function's validated,
--   atomic INSERT ... ON CONFLICT ... DO UPDATE, from every role including
--   service_role. This is the smaller, safer surface, and mirrors the
--   exact pattern already used by public.is_superadmin() in 0001_init.sql
--   (security definer, `set search_path = public`, invoked by a role that
--   holds no direct table grants of its own).
--
--   SET search_path = public (not the caller's search_path) closes the
--   classic SECURITY DEFINER hijack: without it, a caller able to control
--   its own search_path could shadow `public.widget_rate_limit_buckets`
--   with an object in another schema and have this function silently
--   operate on the wrong table. Matches the exact convention already used
--   by is_superadmin()/match_knowledge_chunks()/replace_knowledge_chunks()
--   in 0001_init.sql/0002_rag.sql (`set search_path = public`).
--
-- The function's logic/body is NOT touched — this ALTER changes only its
-- security mode and search_path, nothing about how it computes a decision.
-- widget_rate_limit_cleanup() is deliberately left untouched (still
-- revoked from every PostgREST-reachable role, service_role included): it
-- is never called by any application code path (see
-- supabase/WIDGET_RATE_LIMIT_CLEANUP.md — a manual/operator-run function
-- by design), so granting it anything here would violate "no privilege on
-- an object the widget path doesn't actually use".
alter function public.widget_rate_limit_try_consume(text, integer, integer)
  security definer
  set search_path = public;

grant execute on function public.widget_rate_limit_try_consume(text, integer, integer) to service_role;

-- =========================================================================
-- Deliberately NOT granted to service_role — out of scope for the widget
-- path, confirmed by reading the code above rather than assumed:
--   - widget_rate_limit_buckets (table): no direct grant — see the
--     SECURITY DEFINER decision above; the function is the only door.
--   - widget_rate_limit_cleanup(): operator-run only, never called by the app.
--   - DELETE on any table above: the widget path never deletes anything.
--   - UPDATE on hotels/chatbot_settings/widget_settings/accommodation_types/
--     room_photos/knowledge_chunks/knowledge_sources/message_sources: the
--     widget path only reads or inserts these, never updates them.
--   - profiles, hotel_integrations, hotel_integration_capability_routes,
--     accommodation_inventory_mappings, booking_quotes,
--     reservation_operations, reservation_audit_log, and every other table
--     outside this list: not part of the widget's code path at all.
--   - No grant of any kind to anon or authenticated: unchanged by this
--     migration.
--   - No `alter default privileges`: a future table gets nothing for
--     service_role until a later migration explicitly grants it, same
--     discipline already applied to `authenticated` throughout this project.
-- =========================================================================
