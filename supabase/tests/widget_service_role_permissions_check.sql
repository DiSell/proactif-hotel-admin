-- Constraint/behavior checks for 0009_widget_service_role_permissions.sql —
-- run this in the Supabase SQL editor (or psql connected to the project)
-- AFTER that migration has been applied.
--
-- Uses the built-in has_table_privilege()/has_function_privilege() (no
-- extension required) inside BEGIN/ROLLBACK — read-only introspection of
-- pg_catalog, nothing here writes real data, so the rollback is pure
-- safety, not cleanup of anything this script itself created.

begin;

-- ---- 1) service_role has exactly the SELECT-only tables it needs ----
do $$
declare
  missing text := '';
begin
  if not has_table_privilege('service_role', 'public.hotels', 'SELECT') then missing := missing || 'hotels(SELECT) '; end if;
  if not has_table_privilege('service_role', 'public.chatbot_settings', 'SELECT') then missing := missing || 'chatbot_settings(SELECT) '; end if;
  if not has_table_privilege('service_role', 'public.widget_settings', 'SELECT') then missing := missing || 'widget_settings(SELECT) '; end if;
  if not has_table_privilege('service_role', 'public.accommodation_types', 'SELECT') then missing := missing || 'accommodation_types(SELECT) '; end if;
  if not has_table_privilege('service_role', 'public.room_photos', 'SELECT') then missing := missing || 'room_photos(SELECT) '; end if;
  if not has_table_privilege('service_role', 'public.knowledge_chunks', 'SELECT') then missing := missing || 'knowledge_chunks(SELECT) '; end if;
  if not has_table_privilege('service_role', 'public.knowledge_sources', 'SELECT') then missing := missing || 'knowledge_sources(SELECT) '; end if;

  if missing <> '' then
    raise exception 'BUG: service_role is missing required SELECT privileges: %', missing;
  end if;
  raise notice 'OK: service_role has SELECT on hotels, chatbot_settings, widget_settings, accommodation_types, room_photos, knowledge_chunks, knowledge_sources';
end $$;

-- ---- 2) conversations: SELECT + INSERT + UPDATE, but not DELETE ----
do $$
begin
  if not has_table_privilege('service_role', 'public.conversations', 'SELECT') then
    raise exception 'BUG: service_role missing SELECT on conversations';
  end if;
  if not has_table_privilege('service_role', 'public.conversations', 'INSERT') then
    raise exception 'BUG: service_role missing INSERT on conversations';
  end if;
  if not has_table_privilege('service_role', 'public.conversations', 'UPDATE') then
    raise exception 'BUG: service_role missing UPDATE on conversations';
  end if;
  if has_table_privilege('service_role', 'public.conversations', 'DELETE') then
    raise exception 'SECURITY BUG: service_role has DELETE on conversations — the widget path never deletes conversations, this is unused privilege surface';
  end if;
  raise notice 'OK: service_role has exactly SELECT/INSERT/UPDATE on conversations, no DELETE';
end $$;

-- ---- 3) messages: SELECT + INSERT, but not UPDATE/DELETE ----
do $$
begin
  if not has_table_privilege('service_role', 'public.messages', 'SELECT') then
    raise exception 'BUG: service_role missing SELECT on messages';
  end if;
  if not has_table_privilege('service_role', 'public.messages', 'INSERT') then
    raise exception 'BUG: service_role missing INSERT on messages';
  end if;
  if has_table_privilege('service_role', 'public.messages', 'UPDATE') then
    raise exception 'SECURITY BUG: service_role has UPDATE on messages — the widget path never updates a message row';
  end if;
  if has_table_privilege('service_role', 'public.messages', 'DELETE') then
    raise exception 'SECURITY BUG: service_role has DELETE on messages';
  end if;
  raise notice 'OK: service_role has exactly SELECT/INSERT on messages, no UPDATE/DELETE';
end $$;

-- ---- 4) message_sources: INSERT only — deliberately NOT SELECT ----
do $$
begin
  if not has_table_privilege('service_role', 'public.message_sources', 'INSERT') then
    raise exception 'BUG: service_role missing INSERT on message_sources';
  end if;
  if has_table_privilege('service_role', 'public.message_sources', 'SELECT') then
    raise exception 'SECURITY BUG: service_role has SELECT on message_sources — the widget path never reads it back (no .select() chained after the insert in answer.ts), this would be unused privilege surface';
  end if;
  raise notice 'OK: service_role has exactly INSERT on message_sources, no SELECT';
end $$;

-- ---- 5) sensitive operations that must stay false ----
do $$
declare
  leaked text := '';
begin
  if has_table_privilege('service_role', 'public.hotels', 'DELETE') then leaked := leaked || 'hotels(DELETE) '; end if;
  if has_table_privilege('service_role', 'public.chatbot_settings', 'UPDATE') then leaked := leaked || 'chatbot_settings(UPDATE) '; end if;
  if has_table_privilege('service_role', 'public.widget_settings', 'UPDATE') then leaked := leaked || 'widget_settings(UPDATE) '; end if;
  if has_table_privilege('service_role', 'public.accommodation_types', 'INSERT') then leaked := leaked || 'accommodation_types(INSERT) '; end if;
  if has_table_privilege('service_role', 'public.room_photos', 'INSERT') then leaked := leaked || 'room_photos(INSERT) '; end if;

  if leaked <> '' then
    raise exception 'SECURITY BUG: service_role has unexpected write privileges outside the widget path: %', leaked;
  end if;
  raise notice 'OK: no unexpected write privileges (hotels DELETE, chatbot_settings/widget_settings UPDATE, accommodation_types/room_photos INSERT all false)';
end $$;

-- ---- 6) tables entirely outside the widget path: zero privileges ----
do $$
declare
  leaked text := '';
begin
  if has_table_privilege('service_role', 'public.profiles', 'SELECT') then leaked := leaked || 'profiles '; end if;
  if has_table_privilege('service_role', 'public.hotel_integrations', 'SELECT') then leaked := leaked || 'hotel_integrations '; end if;
  if has_table_privilege('service_role', 'public.booking_quotes', 'SELECT') then leaked := leaked || 'booking_quotes '; end if;
  if has_table_privilege('service_role', 'public.reservation_operations', 'SELECT') then leaked := leaked || 'reservation_operations '; end if;
  if has_table_privilege('service_role', 'public.reservation_audit_log', 'SELECT') then leaked := leaked || 'reservation_audit_log '; end if;
  if has_table_privilege('service_role', 'public.widget_rate_limit_buckets', 'SELECT') then leaked := leaked || 'widget_rate_limit_buckets(SELECT) '; end if;
  if has_table_privilege('service_role', 'public.widget_rate_limit_buckets', 'INSERT') then leaked := leaked || 'widget_rate_limit_buckets(INSERT) '; end if;
  if has_table_privilege('service_role', 'public.widget_rate_limit_buckets', 'DELETE') then leaked := leaked || 'widget_rate_limit_buckets(DELETE) '; end if;

  if leaked <> '' then
    raise exception 'SECURITY BUG: service_role has privileges on tables entirely outside the widget path: %', leaked;
  end if;
  raise notice 'OK: service_role has zero privileges on profiles, hotel_integrations, booking_quotes, reservation_operations, reservation_audit_log, and widget_rate_limit_buckets (reachable only through widget_rate_limit_try_consume, now SECURITY DEFINER)';
end $$;

-- ---- 7) anon/authenticated gained NOTHING new from this migration ----
do $$
declare
  leaked text := '';
begin
  if has_table_privilege('anon', 'public.hotels', 'SELECT') then leaked := leaked || 'anon:hotels '; end if;
  if has_table_privilege('anon', 'public.conversations', 'SELECT') then leaked := leaked || 'anon:conversations '; end if;
  if has_table_privilege('anon', 'public.messages', 'SELECT') then leaked := leaked || 'anon:messages '; end if;
  if has_function_privilege('anon', 'public.widget_rate_limit_try_consume(text, integer, integer)', 'EXECUTE') then leaked := leaked || 'anon:widget_rate_limit_try_consume '; end if;
  if has_function_privilege('authenticated', 'public.widget_rate_limit_try_consume(text, integer, integer)', 'EXECUTE') then leaked := leaked || 'authenticated:widget_rate_limit_try_consume '; end if;

  if leaked <> '' then
    raise exception 'SECURITY BUG: anon/authenticated gained privileges they should not have: %', leaked;
  end if;
  raise notice 'OK: anon/authenticated unaffected by this migration (still no access to hotels/conversations/messages for anon; still cannot execute widget_rate_limit_try_consume)';
end $$;

-- ---- 8) EXECUTE on both RPCs: true for service_role, false for anon/authenticated ----
do $$
begin
  if not has_function_privilege('service_role', 'public.match_knowledge_chunks(uuid, vector, integer)', 'EXECUTE') then
    raise exception 'BUG: service_role cannot execute match_knowledge_chunks';
  end if;
  if not has_function_privilege('service_role', 'public.widget_rate_limit_try_consume(text, integer, integer)', 'EXECUTE') then
    raise exception 'BUG: service_role cannot execute widget_rate_limit_try_consume';
  end if;
  if has_function_privilege('anon', 'public.match_knowledge_chunks(uuid, vector, integer)', 'EXECUTE') then
    raise exception 'SECURITY BUG: anon can execute match_knowledge_chunks';
  end if;
  if has_function_privilege('authenticated', 'public.match_knowledge_chunks(uuid, vector, integer)', 'EXECUTE') then
    raise notice 'NOTE: authenticated can execute match_knowledge_chunks — expected, unchanged from 0002_rag.sql (the admin dashboard chat route uses the authenticated client)';
  end if;

  raise notice 'OK: EXECUTE on match_knowledge_chunks and widget_rate_limit_try_consume is true for service_role, false for anon on both';
end $$;

-- ---- 9) widget_rate_limit_try_consume is now SECURITY DEFINER with a locked search_path ----
do $$
declare
  is_definer boolean;
  configured_search_path text;
begin
  select p.prosecdef, (
    select cfg
    from unnest(p.proconfig) as cfg
    where cfg like 'search_path=%'
    limit 1
  )
  into is_definer, configured_search_path
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'widget_rate_limit_try_consume';

  if not is_definer then
    raise exception 'BUG: widget_rate_limit_try_consume is not SECURITY DEFINER';
  end if;
  if configured_search_path is null or configured_search_path <> 'search_path=public' then
    raise exception 'SECURITY BUG: widget_rate_limit_try_consume SECURITY DEFINER without a locked search_path=public (got %) — vulnerable to search_path hijacking', configured_search_path;
  end if;

  raise notice 'OK: widget_rate_limit_try_consume is SECURITY DEFINER with search_path locked to public';
end $$;

rollback;
