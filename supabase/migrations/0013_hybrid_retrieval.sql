-- =========================================================================
-- Proactif System — hybrid (vector + lexical) knowledge retrieval.
--
-- Additive only. match_knowledge_chunks() (0002_rag.sql) is UNCHANGED and
-- stays fully usable — this migration adds a second, independent RPC next
-- to it, exactly the "prepared for a future hybrid retrieval function"
-- comment on knowledge_chunks.content_tsv (0002_rag.sql) anticipated.
-- Nothing here alters content_tsv, its GIN index, or any existing grant.
--
-- Context: match_knowledge_chunks() only ever returns the top
-- p_match_count chunks BY VECTOR DISTANCE — a chunk with a strong lexical
-- match (an exact phone number, "parking", "train", a proper noun) but a
-- middling embedding similarity is never even considered if it falls
-- outside that vector top-k. This function additionally pulls in a
-- lexical-match candidate pool (via content_tsv) and returns the UNION,
-- with BOTH scores computed for every returned row — never a score
-- defaulted to 0 for a candidate that only entered via the other channel,
-- which would silently defeat the whole point (see the app-side decision
-- rule in features/rag/retrieve.ts, applied in TypeScript, not here: this
-- function returns candidates and their two scores, it does not itself
-- decide accept/fallback).
-- =========================================================================

-- =========================================================================
-- match_knowledge_chunks_hybrid — union of vector-top-k and lexical-top-k
-- candidates for one hotel, each row carrying both a vector_score
-- (identical formula to match_knowledge_chunks: 1 - cosine distance) and a
-- lexical_score (see below), deduplicated by chunk id.
--
-- lexical_score is a COVERAGE RATIO, not ts_rank/ts_rank_cd: the fraction
-- of the query's own distinct, non-stopword lexemes (tokenized with the
-- SAME to_tsvector('simple', ...) config as content_tsv, so both sides are
-- tokenized identically) that are found verbatim in the chunk. Bounded
-- [0,1], easy to reason about and to threshold against — chosen
-- deliberately over ts_rank_cd's own (differently-scaled, TF/length-
-- weighted) output, which is not a plain 0-1 percentage and would not be
-- comparable to a "X% of the query's meaningful words are in this chunk"
-- threshold the way a coverage ratio is.
--
-- STOPWORD_LEXEMES below is a small, generic, LANGUAGE-level list (French/
-- English/Spanish/Dutch function words: "the", "le", "el", "de", "is",
-- "est"...) — not hotel-specific, not intent-specific, not a "parking"
-- keyword list. Its only job is the same one a language-specific
-- to_tsvector config (e.g. 'french') would otherwise play: keep short
-- function words from diluting the coverage ratio's denominator. content
-- stays indexed under 'simple' (0002_rag.sql's own reasoning: the corpus
-- is multilingual, a single stemming language would skew ranking) — this
-- filter is applied only to the QUERY side, at read time, never written
-- back to content_tsv.
--
-- 'simple' does NOT bridge languages and this function does not pretend
-- to: a French query's lexemes ("adresse", "aéroport") will not match an
-- English-only chunk's tokens ("address", "airport") — only the vector
-- channel offers any cross-lingual signal at all. See
-- features/rag/retrieve.ts's own documentation of this same limit.
-- =========================================================================
create or replace function public.match_knowledge_chunks_hybrid(
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
  lexical_score double precision
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
  -- No character-class filter here — an ASCII-only regex would silently
  -- drop every accented lexeme ("privé", "aéroport", "hôtel"), which is
  -- most of what French/Spanish query text actually tokenizes to. Only
  -- the generic stopword filter applies.
  query_lexemes as (
    select
      array_agg(distinct lex) as lexemes,
      count(distinct lex) as lexeme_count
    from unnest(tsvector_to_array(to_tsvector('simple', coalesce(p_query_text, '')))) as lex
    where lex not in (select stopword_lexemes.lex from stopword_lexemes)
  ),
  -- Only built when at least one usable lexeme survives tokenization/
  -- stopword filtering — an all-stopword or empty query text simply skips
  -- the lexical channel entirely (vector_candidates is unaffected).
  --
  -- websearch_to_tsquery, not to_tsquery(array_to_string(...)): lexemes
  -- from tsvector_to_array are plain tokenized words, not pre-escaped
  -- tsquery syntax — a lexeme that happens to contain a character
  -- to_tsquery's own grammar treats as an operator (e.g. a decimal price
  -- fragment, a hyphenated compound) would otherwise raise a syntax error
  -- or be silently misparsed. websearch_to_tsquery parses its ENTIRE
  -- input as plain search text (the same contract plainto_tsquery has,
  -- plus its own safe "OR" keyword support) — safe for any input string,
  -- by design, which is exactly why it exists.
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
  -- OR-combined (not AND/plainto_tsquery): a candidate needs only ONE
  -- surviving lexeme to enter this pool — the precise per-chunk coverage
  -- ratio (computed below, in the final select) is what the app-side
  -- decision rule actually thresholds against, not mere presence here.
  -- AND semantics (plainto_tsquery's default) would require EVERY query
  -- word present verbatim, which a short natural-language question almost
  -- never satisfies against a differently-phrased chunk.
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
    -- plainto_tsquery, not to_tsquery(lex) — same reasoning as
    -- lexical_query above: lex is a plain tokenized word, not pre-escaped
    -- tsquery syntax, and plainto_tsquery accepts any input text safely.
    coalesce((
      select count(*)::float / nullif(ql.lexeme_count, 0)
      from unnest(ql.lexemes) as lex
      where kc.content_tsv @@ plainto_tsquery('simple', lex)
    ), 0)::double precision as lexical_score
  from candidate_ids ci
  join public.knowledge_chunks kc on kc.id = ci.chunk_id
  join public.knowledge_sources ks
    on ks.id = kc.source_id
    and ks.hotel_id = kc.hotel_id
    and ks.is_active
  left join query_lexemes ql on true
  where kc.hotel_id = p_hotel_id;
$$;

-- Same posture as match_knowledge_chunks(uuid, vector, integer)
-- (0002_rag.sql): no PUBLIC execute, granted only to the roles that
-- actually call it. SECURITY INVOKER means the caller still needs the
-- underlying table grants — authenticated and service_role both already
-- hold SELECT on knowledge_chunks/knowledge_sources (0002_rag.sql,
-- 0009_widget_service_role_permissions.sql); no new table grant required,
-- only EXECUTE on this new function.
revoke all on function public.match_knowledge_chunks_hybrid(uuid, vector, text, int) from public;
grant execute on function public.match_knowledge_chunks_hybrid(uuid, vector, text, int) to authenticated;
grant execute on function public.match_knowledge_chunks_hybrid(uuid, vector, text, int) to service_role;
