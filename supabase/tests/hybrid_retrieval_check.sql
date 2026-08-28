-- Constraint/behavior checks for 0013_hybrid_retrieval.sql — run this in
-- the Supabase SQL editor (or psql connected to the project) AFTER that
-- migration has been applied.
--
-- BEGIN/ROLLBACK, same style as every other test script in this project —
-- everything this script writes is rolled back at the end. No real
-- project data is touched.
--
-- Fixture embeddings are deliberately synthetic, not real
-- text-embedding-3-small output: this file tests RPC-level behavior
-- (hotel_id isolation, inactive-source exclusion, chunk deduplication,
-- both scores genuinely computed rather than defaulted) which only needs
-- CONTROLLED similarity relationships, not semantically meaningful ones.
-- Real embedding score behavior (recall/precision at realistic content)
-- is covered by the application-level benchmark instead, not by SQL.

begin;

do $$
declare
  hotel_a uuid;
  hotel_b uuid;
  source_a_active uuid;
  source_a_inactive uuid;
  source_b_active uuid;
  chunk_a_vector_and_lexical uuid;
  chunk_a_lexical_only uuid;
  chunk_a_inactive uuid;
  chunk_b uuid;
  v_query_embedding vector(1536);
  v_matching_embedding vector(1536);
  v_far_embedding vector(1536);
  result_count int;
begin
  -- ---- fixtures ----
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Hybrid Test Hotel A', 'hybrid-test-hotel-a', 'ps_live_hybrid_test_a', 'active', true)
  returning id into hotel_a;

  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Hybrid Test Hotel B', 'hybrid-test-hotel-b', 'ps_live_hybrid_test_b', 'active', true)
  returning id into hotel_b;

  insert into public.knowledge_sources (hotel_id, type, title, status, is_active)
  values (hotel_a, 'text', 'Source A active', 'indexed', true) returning id into source_a_active;
  insert into public.knowledge_sources (hotel_id, type, title, status, is_active)
  values (hotel_a, 'text', 'Source A inactive', 'indexed', false) returning id into source_a_inactive;
  insert into public.knowledge_sources (hotel_id, type, title, status, is_active)
  values (hotel_b, 'text', 'Source B active', 'indexed', true) returning id into source_b_active;

  -- Query embedding and a fixture embedding IDENTICAL to it (cosine
  -- similarity = 1.0, unambiguously a vector-top-k candidate) vs. one far
  -- from it (alternating sign, cosine similarity close to -1..0, never a
  -- vector-top-k candidate on its own).
  v_query_embedding := array_fill(1, array[1536])::vector;
  v_matching_embedding := array_fill(1, array[1536])::vector;
  select array_agg(case when i % 2 = 0 then 1 else -1 end)::vector into v_far_embedding
  from generate_series(1, 1536) as i;

  -- Chunk that is BOTH a strong vector match AND a strong lexical match —
  -- the deduplication case (#8).
  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_a, source_a_active, 'Le parking privé de la résidence est gratuit et surveillé.', v_matching_embedding, 0)
  returning id into chunk_a_vector_and_lexical;

  -- Chunk that is a strong LEXICAL match only — far embedding, so it would
  -- never appear via match_knowledge_chunks() alone (the whole reason this
  -- migration exists), but must still appear here, with its REAL
  -- (low) vector_score actually computed, never defaulted to 0/null.
  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_a, source_a_active, 'Informations sur le parking gratuit et privé de l''hôtel.', v_far_embedding, 1)
  returning id into chunk_a_lexical_only;

  -- Chunk on an INACTIVE source — strong on both channels by construction,
  -- must NEVER appear in the result no matter how well it would score.
  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_a, source_a_inactive, 'Le parking privé et gratuit est disponible.', v_matching_embedding, 0)
  returning id into chunk_a_inactive;

  -- Chunk belonging to a DIFFERENT hotel — strong on both channels by
  -- construction, must never leak into hotel_a's results.
  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  values (hotel_b, source_b_active, 'Le parking privé et gratuit est disponible.', v_matching_embedding, 0)
  returning id into chunk_b;

  raise notice 'OK: fixtures created (hotel_a=%, hotel_b=%)', hotel_a, hotel_b;

  -- ================================================================
  -- 1) hotel_id isolation — hotel_b's chunk never appears for hotel_a's query
  -- ================================================================
  if exists (
    select 1 from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'parking privé gratuit', 10)
    where chunk_id = chunk_b
  ) then
    raise exception 'SECURITY BUG: match_knowledge_chunks_hybrid(hotel_a, ...) returned a chunk belonging to hotel_b';
  end if;
  raise notice 'OK: hotel_id isolation — no cross-hotel chunk leak';

  -- ================================================================
  -- 2) inactive source never used — chunk_a_inactive never appears, even
  --    though it would score as well as chunk_a_vector_and_lexical on
  --    both channels
  -- ================================================================
  if exists (
    select 1 from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'parking privé gratuit', 10)
    where chunk_id = chunk_a_inactive
  ) then
    raise exception 'BUG: match_knowledge_chunks_hybrid returned a chunk from an inactive knowledge_source';
  end if;
  raise notice 'OK: inactive source excluded from both the vector and lexical candidate pools';

  -- ================================================================
  -- 3) deduplication — a chunk that qualifies via BOTH the vector and
  --    lexical candidate pools appears EXACTLY ONCE, with both scores
  --    genuinely computed (not one defaulted away by the union)
  -- ================================================================
  select count(*) into result_count
  from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'parking privé gratuit', 10)
  where chunk_id = chunk_a_vector_and_lexical;
  if result_count <> 1 then
    raise exception 'BUG: chunk % appeared % times (expected exactly 1) — deduplication failed', chunk_a_vector_and_lexical, result_count;
  end if;

  if not exists (
    select 1 from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'parking privé gratuit', 10)
    where chunk_id = chunk_a_vector_and_lexical and vector_score > 0.99 and lexical_score > 0
  ) then
    raise exception 'BUG: the vector+lexical chunk is missing a genuinely-computed vector_score and/or lexical_score';
  end if;
  raise notice 'OK: a chunk matched by both channels is deduplicated to exactly one row, both scores populated';

  -- ================================================================
  -- 4) lexical-only candidate: still returned, with its REAL (low) vector
  --    score actually computed — never defaulted to 0/null just because
  --    it entered only via the lexical channel
  -- ================================================================
  if not exists (
    select 1 from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'parking privé gratuit', 10)
    where chunk_id = chunk_a_lexical_only and lexical_score > 0 and vector_score is not null and vector_score < 0.5
  ) then
    raise exception 'BUG: the lexical-only chunk is missing a genuine (low) vector_score, or missing entirely';
  end if;
  raise notice 'OK: a lexical-only candidate carries a genuinely-computed (low) vector_score, not a default';

  -- ================================================================
  -- 5) an all-stopword / empty query text degrades to vector-only
  --    behavior, never an error (division-by-zero / empty tsquery guard)
  -- ================================================================
  perform * from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, '', 10);
  perform * from public.match_knowledge_chunks_hybrid(hotel_a, v_query_embedding, 'le la de', 10);
  raise notice 'OK: empty/all-stopword query text does not error — degrades to vector-only candidates';
end $$;

-- ================================================================
-- 6) match_knowledge_chunks_hybrid — SECURITY INVOKER / search_path audit
--    (mirrors 0011_hotel_client_portal.sql's own audit of is_hotel_admin_for)
-- ================================================================
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
  where n.nspname = 'public' and p.proname = 'match_knowledge_chunks_hybrid';

  if is_definer then
    raise exception 'SECURITY BUG: match_knowledge_chunks_hybrid is SECURITY DEFINER — must stay SECURITY INVOKER, same posture as match_knowledge_chunks';
  end if;
  if configured_search_path is null or configured_search_path <> 'search_path=public' then
    raise exception 'SECURITY BUG: match_knowledge_chunks_hybrid has no locked search_path=public (got %)', configured_search_path;
  end if;
  raise notice 'OK: match_knowledge_chunks_hybrid is SECURITY INVOKER with search_path locked to public';
end $$;

-- ================================================================
-- 7) grants — authenticated and service_role have EXECUTE; anon does not;
--    match_knowledge_chunks (the pre-existing function) is untouched
-- ================================================================
do $$
declare
  bad text := '';
begin
  if not has_function_privilege('authenticated', 'public.match_knowledge_chunks_hybrid(uuid, vector, text, int)', 'EXECUTE') then
    bad := bad || 'authenticated:missing EXECUTE ';
  end if;
  if not has_function_privilege('service_role', 'public.match_knowledge_chunks_hybrid(uuid, vector, text, int)', 'EXECUTE') then
    bad := bad || 'service_role:missing EXECUTE ';
  end if;
  if has_function_privilege('anon', 'public.match_knowledge_chunks_hybrid(uuid, vector, text, int)', 'EXECUTE') then
    bad := bad || 'anon:unexpected EXECUTE ';
  end if;
  if not has_function_privilege('service_role', 'public.match_knowledge_chunks(uuid, vector, integer)', 'EXECUTE') then
    bad := bad || 'match_knowledge_chunks (pre-existing):unexpectedly missing EXECUTE for service_role — this migration must not have touched it ';
  end if;

  if bad <> '' then
    raise exception 'BUG: unexpected grant state: %', bad;
  end if;
  raise notice 'OK: authenticated and service_role have EXECUTE on match_knowledge_chunks_hybrid, anon does not, and the pre-existing match_knowledge_chunks grant is untouched';
end $$;

-- ================================================================
-- 8) p_match_count boundary behavior — 0, negative, huge, and NULL
--    must never error and must stay within the bound the SQL's own
--    `limit least(greatest(p_match_count, 1), 20)` formula (applied
--    identically to both the vector and the lexical pool) implies.
--
--    Isolated fixtures (a dedicated hotel_c, 45 active chunks, ALL
--    matching both the vector query — identical embedding, so every
--    one ties at vector_score 1.0 — and the lexical query — every one
--    shares one distinctive token) so the LIMIT 20 cap is actually
--    exercised by real data, not merely coincidentally satisfied
--    because too few fixture rows exist. Kept entirely separate from
--    hotel_a/hotel_b above: bulk-inserting 45 extra tied-embedding
--    chunks into hotel_a's existing source could otherwise perturb
--    which rows land in checks 1-4's own top-k (ties have no
--    guaranteed ORDER BY stability), weakening assertions that
--    already pass.
--
--    Theoretical bound, derived directly from the SQL above (not
--    assumed):
--
--      p_match_count IN (0, -10, NULL): greatest(p_match_count, 1)
--      evaluates to exactly 1 in all three cases — Postgres's
--      GREATEST/LEAST ignore NULL arguments (documented behavior:
--      "NULL values in the argument list are ignored, and the result
--      will be NULL only if all the expressions evaluate to NULL"),
--      and 1 is simply the larger value against 0 or -10. so
--      least(1, 20) = 1 -> LIMIT 1 on EACH pool. With 45 active
--      chunks available, LIMIT 1 always returns EXACTLY 1 row per
--      pool (never 0, never more). The union of two 1-row sets is 1
--      row (if the same chunk won both pools) or 2 rows (if
--      different) -> result_count is always in [1, 2].
--
--      p_match_count = 99999: least(greatest(99999, 1), 20) = 20 ->
--      LIMIT 20 on EACH pool. With 45 rows available (>= 20), each
--      pool returns EXACTLY 20 rows. |A union B| = |A| + |B| -
--      |A inter B| = 40 - |A inter B|, and |A inter B| ranges from
--      max(0, 20 + 20 - 45) = 0 (the two 20-subsets could be fully
--      disjoint) to min(20, 20) = 20 (fully identical) -> result_count
--      is always in [20, 40]. 45 was chosen SPECIFICALLY so that
--      2*20 = 40 < 45: the [20, 40] bound is strictly tighter than
--      "bounded by the 45 rows that happen to exist", which is what
--      actually proves the LIMIT 20 cap is enforced rather than the
--      assertion merely passing because the fixture was too small to
--      ever exceed it.
-- ================================================================
do $$
declare
  hotel_c uuid;
  source_c_active uuid;
  v_query_embedding vector(1536);
  v_matching_embedding vector(1536);
  result_count int;
begin
  insert into public.hotels (name, slug, widget_key, status, assistant_enabled)
  values ('Hybrid Test Hotel C (match_count)', 'hybrid-test-hotel-c', 'ps_live_hybrid_test_c', 'active', true)
  returning id into hotel_c;

  insert into public.knowledge_sources (hotel_id, type, title, status, is_active)
  values (hotel_c, 'text', 'Source C active', 'indexed', true)
  returning id into source_c_active;

  v_query_embedding := array_fill(1, array[1536])::vector;
  v_matching_embedding := array_fill(1, array[1536])::vector;

  -- 45 chunks, every one identical on both channels: same embedding as
  -- the query (vector_score = 1.0 for all 45), and all sharing one
  -- made-up, distinctive token nothing else in this file could
  -- accidentally also match.
  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index)
  select hotel_c, source_c_active, 'Motclefuniquebornetest numero ' || i, v_matching_embedding, i
  from generate_series(1, 45) as i;

  -- ---- p_match_count = 0 ----
  select count(*) into result_count
  from public.match_knowledge_chunks_hybrid(hotel_c, v_query_embedding, 'motclefuniquebornetest', 0);
  if result_count < 1 or result_count > 2 then
    raise exception 'BUG: p_match_count=0 returned % rows, expected between 1 and 2 (LIMIT clamps to 1 per pool)', result_count;
  end if;

  -- ---- p_match_count = -10 (negative) ----
  select count(*) into result_count
  from public.match_knowledge_chunks_hybrid(hotel_c, v_query_embedding, 'motclefuniquebornetest', -10);
  if result_count < 1 or result_count > 2 then
    raise exception 'BUG: p_match_count=-10 returned % rows, expected between 1 and 2 (LIMIT clamps to 1 per pool)', result_count;
  end if;

  -- ---- p_match_count = NULL ----
  select count(*) into result_count
  from public.match_knowledge_chunks_hybrid(hotel_c, v_query_embedding, 'motclefuniquebornetest', null);
  if result_count < 1 or result_count > 2 then
    raise exception 'BUG: p_match_count=NULL returned % rows, expected between 1 and 2 (GREATEST ignores NULL, clamps to 1 per pool)', result_count;
  end if;

  -- ---- p_match_count = 99999 (huge) ----
  select count(*) into result_count
  from public.match_knowledge_chunks_hybrid(hotel_c, v_query_embedding, 'motclefuniquebornetest', 99999);
  if result_count < 20 or result_count > 40 then
    raise exception 'BUG: p_match_count=99999 returned % rows, expected between 20 and 40 (LIMIT clamps to 20 per pool; 45 fixture rows were available, so a result above 40 would prove the cap is not enforced, not just that data ran out)', result_count;
  end if;

  raise notice 'OK: p_match_count of 0, -10, NULL, and 99999 all execute without error and stay within the bound implied by limit least(greatest(p_match_count,1),20) — [1,2] rows for 0/-10/NULL, [20,40] rows for 99999, verified against a 45-chunk fixture built specifically to exceed 2x the 20-cap';
end $$;

rollback;
