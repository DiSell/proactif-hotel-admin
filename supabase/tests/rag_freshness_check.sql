-- Constraint/behavior checks for 0016_rag_freshness.sql — run this in the
-- Supabase SQL editor (or psql connected to the project) AFTER that
-- migration has been applied, same convention as
-- supabase/tests/hybrid_retrieval_check.sql (which already covers tenant
-- isolation, inactive-source exclusion, dedup, and p_match_count bounds for
-- match_knowledge_chunks_hybrid in depth — not repeated here). This file
-- only checks what 0016 actually changed: the two new output columns
-- (source_url, last_synced_at) on both match_knowledge_chunks() and
-- match_knowledge_chunks_hybrid(), that nothing else about scoring/ranking
-- moved, and that every grant/security property survived the DROP+CREATE.
--
-- BEGIN/ROLLBACK — everything this script writes is rolled back at the end.

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  source_url_active uuid;
  source_no_url_active uuid;
  source_b_active uuid;
  chunk_url uuid;
  chunk_no_url uuid;
  chunk_b uuid;
  v_query_embedding vector(1536);
  row_source_url text;
  row_last_synced_at timestamptz;
  row_similarity double precision;
  legacy_similarity double precision;
  hybrid_vector_score double precision;
begin
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Freshness Test Hotel A', 'freshness-test-hotel-a', 'ps_live_freshness_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Freshness Test Hotel B', 'freshness-test-hotel-b', 'ps_live_freshness_test_b', 'active', true)
  returning id into hotel_b;

  -- A URL source with a known source_url and last_synced_at.
  insert into public.knowledge_sources (hotel_id, type, title, source_url, status, is_active, last_synced_at)
  values (hotel_a, 'url', 'Le Bistrot', 'https://le1837.example.com/en', 'indexed', true, '2026-08-22T17:25:43.886Z')
  returning id into source_url_active;

  -- A non-URL source (text) — source_url must come back NULL, never fabricated.
  insert into public.knowledge_sources (hotel_id, type, title, status, is_active)
  values (hotel_a, 'text', 'FAQ interne', 'indexed', true)
  returning id into source_no_url_active;

  insert into public.knowledge_sources (hotel_id, type, title, source_url, status, is_active, last_synced_at)
  values (hotel_b, 'url', 'Autre hôtel', 'https://other-hotel.example.com', 'indexed', true, now())
  returning id into source_b_active;

  v_query_embedding := array_fill(1, array[1536])::vector;

  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_a, source_url_active, 'Le restaurant est ouvert tous les jours de 12h à 22h.', v_query_embedding, 0)
  returning id into chunk_url;

  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_a, source_no_url_active, 'Réponse à une question interne.', v_query_embedding, 0)
  returning id into chunk_no_url;

  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_b, source_b_active, 'Contenu appartenant a un autre hotel.', v_query_embedding, 0)
  returning id into chunk_b;

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%)', hotel_a, hotel_b;

  -- ================================================================
  -- 1) match_knowledge_chunks_hybrid — source_url/last_synced_at returned
  --    correctly for a URL source
  -- ================================================================
  select source_url, last_synced_at, vector_score
  into row_source_url, row_last_synced_at, hybrid_vector_score
  from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'restaurant ouvert', 10)
  where chunk_id = chunk_url;

  if row_source_url is distinct from 'https://le1837.example.com/en' then
    raise exception 'BUG: expected source_url ''https://le1837.example.com/en'', got %', row_source_url;
  end if;
  if row_last_synced_at is distinct from '2026-08-22T17:25:43.886Z'::timestamptz then
    raise exception 'BUG: expected last_synced_at 2026-08-22T17:25:43.886Z, got %', row_last_synced_at;
  end if;
  if hybrid_vector_score < 0.99 then
    raise exception 'BUG: vector_score for an identical-embedding chunk should be ~1.0, got % — scoring logic may have been altered', hybrid_vector_score;
  end if;
  raise notice 'OK: match_knowledge_chunks_hybrid returns the correct source_url/last_synced_at, vector_score unchanged';

  -- ================================================================
  -- 2) match_knowledge_chunks_hybrid — a non-URL source returns
  --    source_url IS NULL, never an empty string or fabricated value
  -- ================================================================
  select source_url into row_source_url
  from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'question interne', 10)
  where chunk_id = chunk_no_url;

  if row_source_url is not null then
    raise exception 'BUG: expected source_url NULL for a non-URL source, got %', row_source_url;
  end if;
  raise notice 'OK: a non-URL source returns source_url = NULL, not fabricated';

  -- ================================================================
  -- 3) tenant isolation unchanged — hotel_b's chunk never leaks for hotel_a
  -- ================================================================
  if exists (
    select 1 from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'restaurant ouvert', 10)
    where chunk_id = chunk_b
  ) then
    raise exception 'SECURITY BUG: match_knowledge_chunks_hybrid(hotel_a, ...) returned a chunk belonging to hotel_b after the 0016 DROP+CREATE';
  end if;
  raise notice 'OK: hotel_id isolation still holds after the 0016 DROP+CREATE';

  -- ================================================================
  -- 4) match_knowledge_chunks (legacy) — same two new columns, same
  --    similarity formula unchanged
  -- ================================================================
  select source_url, last_synced_at, similarity
  into row_source_url, row_last_synced_at, legacy_similarity
  from public.match_knowledge_chunks(hotel_a, v_query_embedding, 10)
  where chunk_id = chunk_url;

  if row_source_url is distinct from 'https://le1837.example.com/en' then
    raise exception 'BUG: match_knowledge_chunks: expected source_url ''https://le1837.example.com/en'', got %', row_source_url;
  end if;
  if row_last_synced_at is distinct from '2026-08-22T17:25:43.886Z'::timestamptz then
    raise exception 'BUG: match_knowledge_chunks: expected last_synced_at 2026-08-22T17:25:43.886Z, got %', row_last_synced_at;
  end if;
  if legacy_similarity < 0.99 then
    raise exception 'BUG: match_knowledge_chunks: similarity for an identical-embedding chunk should be ~1.0, got % — scoring logic may have been altered', legacy_similarity;
  end if;
  raise notice 'OK: match_knowledge_chunks (legacy) returns the correct source_url/last_synced_at, similarity unchanged';
end $$;

-- ================================================================
-- 5) SECURITY INVOKER / search_path — both functions, after DROP+CREATE
-- ================================================================
do $$
declare
  fn text;
  is_definer boolean;
  configured_search_path text;
begin
  foreach fn in array array['match_knowledge_chunks', 'match_knowledge_chunks_hybrid'] loop
    select p.prosecdef, (
      select cfg from unnest(p.proconfig) as cfg where cfg like 'search_path=%' limit 1
    )
    into is_definer, configured_search_path
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = fn;

    if is_definer then
      raise exception 'SECURITY BUG: % is SECURITY DEFINER after 0016 — must stay SECURITY INVOKER', fn;
    end if;
    if configured_search_path is null or configured_search_path <> 'search_path=public' then
      raise exception 'SECURITY BUG: % has no locked search_path=public after 0016 (got %)', fn, configured_search_path;
    end if;
  end loop;
  raise notice 'OK: both functions are still SECURITY INVOKER with search_path locked to public after the 0016 DROP+CREATE';
end $$;

-- ================================================================
-- 6) grants — authenticated and service_role keep EXECUTE on both
--    functions; anon still has none. This is the property most at risk
--    from a DROP+CREATE (grants do not survive a DROP).
-- ================================================================
do $$
declare
  bad text := '';
begin
  if not has_function_privilege('authenticated', 'public.match_knowledge_chunks(uuid, vector, int)', 'EXECUTE') then
    bad := bad || 'match_knowledge_chunks/authenticated:missing EXECUTE ';
  end if;
  if not has_function_privilege('service_role', 'public.match_knowledge_chunks(uuid, vector, int)', 'EXECUTE') then
    bad := bad || 'match_knowledge_chunks/service_role:missing EXECUTE ';
  end if;
  if has_function_privilege('anon', 'public.match_knowledge_chunks(uuid, vector, int)', 'EXECUTE') then
    bad := bad || 'match_knowledge_chunks/anon:unexpected EXECUTE ';
  end if;

  if not has_function_privilege('authenticated', 'public.match_knowledge_chunks_hybrid(uuid, vector, text, int)', 'EXECUTE') then
    bad := bad || 'match_knowledge_chunks_hybrid/authenticated:missing EXECUTE ';
  end if;
  if not has_function_privilege('service_role', 'public.match_knowledge_chunks_hybrid(uuid, vector, text, int)', 'EXECUTE') then
    bad := bad || 'match_knowledge_chunks_hybrid/service_role:missing EXECUTE ';
  end if;
  if has_function_privilege('anon', 'public.match_knowledge_chunks_hybrid(uuid, vector, text, int)', 'EXECUTE') then
    bad := bad || 'match_knowledge_chunks_hybrid/anon:unexpected EXECUTE ';
  end if;

  if bad <> '' then
    raise exception 'BUG: unexpected grant state after 0016''s DROP+CREATE: %', bad;
  end if;
  raise notice 'OK: authenticated and service_role keep EXECUTE on both functions, anon still has none';
end $$;

-- ================================================================
-- 7) unique (hotel_id, source_url) partial index — duplicate URL for the
--    same hotel is rejected; same URL across two different hotels is fine;
--    multiple NULL source_url rows for the same hotel are fine.
-- ================================================================
do $$
declare
  hotel_c uuid;
  hotel_d uuid;
  caught boolean := false;
begin
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Freshness Test Hotel C (uniqueness)', 'freshness-test-hotel-c', 'ps_live_freshness_test_c', 'active', true)
  returning id into hotel_c;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Freshness Test Hotel D (uniqueness)', 'freshness-test-hotel-d', 'ps_live_freshness_test_d', 'active', true)
  returning id into hotel_d;

  insert into public.knowledge_sources (hotel_id, type, title, source_url, status, is_active)
  values (hotel_c, 'url', 'Page 1', 'https://hotel-c.example.com/rooms', 'indexed', true);

  begin
    insert into public.knowledge_sources (hotel_id, type, title, source_url, status, is_active)
    values (hotel_c, 'url', 'Page 1 doublon', 'https://hotel-c.example.com/rooms', 'pending', true);
    caught := false;
  exception when unique_violation then
    caught := true;
  end;
  if not caught then
    raise exception 'BUG: inserting a duplicate (hotel_id, source_url) for the same hotel was NOT rejected';
  end if;
  raise notice 'OK: duplicate source_url for the same hotel is rejected';

  -- Same URL, different hotel — must be allowed.
  insert into public.knowledge_sources (hotel_id, type, title, source_url, status, is_active)
  values (hotel_d, 'url', 'Page 1 chez un autre hotel', 'https://hotel-c.example.com/rooms', 'indexed', true);
  raise notice 'OK: the same source_url is allowed across two different hotels';

  -- Multiple NULL source_url rows for the same hotel — must be allowed
  -- (the index is partial, WHERE source_url IS NOT NULL).
  insert into public.knowledge_sources (hotel_id, type, title, status, is_active) values (hotel_c, 'text', 'Note 1', 'indexed', true);
  insert into public.knowledge_sources (hotel_id, type, title, status, is_active) values (hotel_c, 'text', 'Note 2', 'indexed', true);
  raise notice 'OK: multiple NULL source_url rows for the same hotel remain allowed (partial index)';
end $$;

rollback;
