-- =========================================================================
-- Proactif System — RAG freshness / staleness MVP.
--
-- Additive only. Does not modify any table/policy/grant from 0001_init.sql
-- through 0015_hotel_partners.sql beyond what is explicitly re-created
-- below. Fixes the gap the RAG audit identified: the chatbot is never told
-- when a knowledge_source was last synchronized, so it can present a
-- months-old opening-hours/price/menu fact with the same authority as a
-- verified-today one. This migration only plumbs the DATA through
-- (source_url, last_synced_at) — the actual freshness reasoning/wording is
-- entirely in the application layer (features/rag/prompt.ts,
-- features/rag/staleness.ts), never in SQL.
--
-- Two independent changes:
--   1) match_knowledge_chunks() and match_knowledge_chunks_hybrid() now
--      also return source_url and last_synced_at per row.
--   2) A partial unique index prevents two knowledge_sources rows for the
--      same hotel from sharing the same non-null source_url (previously
--      enforced only in application code — see features/knowledge/
--      actions.ts's own comment acknowledging the gap).
--
-- Nothing about vector/lexical scoring, thresholds, hotel_id/is_active
-- filtering, p_match_count clamping, SECURITY INVOKER, or search_path
-- changes for either function — every clause below is copied verbatim from
-- 0002_rag.sql / 0013_hybrid_retrieval.sql except for the two added output
-- columns and their one extra source_url/last_synced_at select expression.
-- =========================================================================

-- =========================================================================
-- 1a) match_knowledge_chunks — PostgreSQL does not allow CREATE OR REPLACE
-- FUNCTION to change an existing function's RETURNS TABLE column list, so
-- this is a controlled DROP + CREATE. Grants do not survive a DROP, so both
-- of this function's real grants (authenticated: 0002_rag.sql, service_role:
-- 0009_widget_service_role_permissions.sql) are re-applied immediately
-- after, identically to how they read today.
-- =========================================================================
drop function if exists public.match_knowledge_chunks(uuid, vector, int);

create function public.match_knowledge_chunks(
  p_hotel_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 6
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_title text,
  content text,
  similarity double precision,
  source_url text,
  last_synced_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    kc.id as chunk_id,
    kc.source_id,
    ks.title as source_title,
    kc.content,
    1 - (kc.embedding <=> p_query_embedding) as similarity,
    ks.source_url,
    ks.last_synced_at
  from public.knowledge_chunks kc
  join public.knowledge_sources ks
    on ks.id = kc.source_id
    and ks.hotel_id = kc.hotel_id
    and ks.is_active
  where kc.hotel_id = p_hotel_id
  order by kc.embedding <=> p_query_embedding
  limit least(greatest(p_match_count, 1), 20);
$$;

revoke all on function public.match_knowledge_chunks(uuid, vector, int) from public;
grant execute on function public.match_knowledge_chunks(uuid, vector, int) to authenticated;
grant execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;

-- =========================================================================
-- 1b) match_knowledge_chunks_hybrid — same treatment. All three real grants
-- (authenticated/service_role from 0013_hybrid_retrieval.sql; anon never
-- had one) re-applied identically.
-- =========================================================================
drop function if exists public.match_knowledge_chunks_hybrid(uuid, vector, text, int);

create function public.match_knowledge_chunks_hybrid(
  p_hotel_id uuid,
  p_query_embedding vector(1536),
  p_query_text text,
  p_match_count int default 6
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_title text,
  content text,
  vector_score double precision,
  lexical_score double precision,
  source_url text,
  last_synced_at timestamptz
)
language sql
stable
security invoker
set search_path = public
as $$
  with
  stopword_lexemes(lex) as (
    values
      ('le'), ('la'), ('les'), ('un'), ('une'), ('des'), ('de'), ('du'), ('au'), ('aux'),
      ('et'), ('est'), ('es'), ('sont'), ('ce'), ('cette'), ('cet'), ('ces'),
      ('qui'), ('que'), ('quoi'), ('ou'), ('comment'), ('quel'), ('quelle'), ('quels'), ('quelles'),
      ('vous'), ('votre'), ('vos'), ('avez'), ('avons'), ('a'), ('il'), ('elle'), ('ils'), ('elles'),
      ('y'), ('en'), ('pour'), ('avec'), ('sur'), ('dans'), ('par'),
      ('the'), ('is'), ('are'), ('what'), ('which'), ('how'), ('do'), ('does'), ('you'), ('your'),
      ('i'), ('to'), ('at'), ('in'), ('on'), ('for'), ('from'), ('and'), ('or'),
      ('el'), ('los'), ('las'), ('que'), ('como'), ('donde'), ('tiene'), ('su'), ('una'), ('y'), ('es'), ('son'),
      ('het'), ('een'), ('zijn'), ('wat'), ('hoe'), ('waar'), ('heeft'), ('uw')
  ),
  query_lexemes as (
    select
      array_agg(distinct lex) as lexemes,
      count(distinct lex) as lexeme_count
    from unnest(tsvector_to_array(to_tsvector('simple', coalesce(p_query_text, '')))) as lex
    where lex not in (select stopword_lexemes.lex from stopword_lexemes)
  ),
  lexical_query as (
    select websearch_to_tsquery('simple', array_to_string(lexemes, ' OR ')) as query
    from query_lexemes
    where lexeme_count > 0
  ),
  vector_candidates as (
    select kc.id as chunk_id
    from public.knowledge_chunks kc
    join public.knowledge_sources ks
      on ks.id = kc.source_id
      and ks.hotel_id = kc.hotel_id
      and ks.is_active
    where kc.hotel_id = p_hotel_id
    order by kc.embedding <=> p_query_embedding
    limit least(greatest(p_match_count, 1), 20)
  ),
  lexical_candidates as (
    select kc.id as chunk_id
    from public.knowledge_chunks kc
    join public.knowledge_sources ks
      on ks.id = kc.source_id
      and ks.hotel_id = kc.hotel_id
      and ks.is_active
    cross join lexical_query lq
    where kc.hotel_id = p_hotel_id
      and kc.content_tsv @@ lq.query
    order by ts_rank_cd(kc.content_tsv, lq.query) desc
    limit least(greatest(p_match_count, 1), 20)
  ),
  candidate_ids as (
    select chunk_id from vector_candidates
    union
    select chunk_id from lexical_candidates
  )
  select
    kc.id as chunk_id,
    kc.source_id,
    ks.title as source_title,
    kc.content,
    (1 - (kc.embedding <=> p_query_embedding))::double precision as vector_score,
    coalesce((
      select count(*)::float / nullif(ql.lexeme_count, 0)
      from unnest(ql.lexemes) as lex
      where kc.content_tsv @@ plainto_tsquery('simple', lex)
    ), 0)::double precision as lexical_score,
    ks.source_url,
    ks.last_synced_at
  from candidate_ids ci
  join public.knowledge_chunks kc on kc.id = ci.chunk_id
  join public.knowledge_sources ks
    on ks.id = kc.source_id
    and ks.hotel_id = kc.hotel_id
    and ks.is_active
  left join query_lexemes ql on true
  where kc.hotel_id = p_hotel_id;
$$;

revoke all on function public.match_knowledge_chunks_hybrid(uuid, vector, text, int) from public;
grant execute on function public.match_knowledge_chunks_hybrid(uuid, vector, text, int) to authenticated;
grant execute on function public.match_knowledge_chunks_hybrid(uuid, vector, text, int) to service_role;

-- =========================================================================
-- 2) Unique (hotel_id, source_url) for URL sources — closes the gap
-- features/knowledge/actions.ts's importCrawledPages doc comment already
-- acknowledges ("there's no DB uniqueness constraint on that pair").
-- Partial (WHERE source_url IS NOT NULL) so text/faq/internal_note/document
-- sources, which never have a source_url, are entirely unaffected and can
-- freely repeat NULL.
--
-- Fails loudly instead of silently picking a row: if duplicates already
-- exist, this migration must not proceed by arbitrarily keeping one and
-- orphaning/deleting the other — that is a data decision for a human, not
-- this migration. The explicit check below gives a clear, actionable error
-- naming the problem; CREATE UNIQUE INDEX would otherwise fail too, but
-- with a much less legible constraint-violation message.
-- =========================================================================
do $$
declare
  duplicate_group_count int;
begin
  select count(*) into duplicate_group_count
  from (
    select hotel_id, source_url
    from public.knowledge_sources
    where source_url is not null
    group by hotel_id, source_url
    having count(*) > 1
  ) dupes;

  if duplicate_group_count > 0 then
    raise exception 'knowledge_sources has % duplicate (hotel_id, source_url) group(s) with a non-null source_url — resolve them manually (merge or delete the extra rows) before re-running 0016_rag_freshness.sql. This migration never deletes or merges rows automatically.', duplicate_group_count;
  end if;
end $$;

create unique index if not exists knowledge_sources_hotel_id_source_url_key
  on public.knowledge_sources (hotel_id, source_url)
  where source_url is not null;
