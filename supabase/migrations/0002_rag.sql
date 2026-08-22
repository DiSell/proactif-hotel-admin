-- Proactif System — Jalon 2 : moteur RAG multi-tenant
-- Additive only. Does not touch anything created by 0001_init.sql.
--
-- IMPORTANT: vector(1536) below is sized for OpenAI's text-embedding-3-small.
-- Switching OPENAI_EMBEDDING_MODEL to a model with a different output
-- dimension requires a NEW migration (a differently-sized vector column)
-- and a full re-embed of every existing chunk — it is not a drop-in env
-- var change.

-- =========================================================================
-- messages — extend with RAG outcome + usage/cost tracking
-- =========================================================================
-- All nullable: only ever populated for assistant messages produced by the
-- RAG engine; user messages and anything from before this migration keep
-- these columns null.
alter table public.messages
  add column answer_status text check (answer_status in ('answered', 'fallback', 'error', 'handoff')),
  add column model text,
  add column input_tokens integer,
  add column output_tokens integer,
  add column embedding_tokens integer,
  add column latency_ms integer;

-- =========================================================================
-- knowledge_chunks
-- =========================================================================
create table public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  content text not null,
  embedding vector(1536) not null,
  chunk_index integer not null,
  token_count integer,
  metadata jsonb not null default '{}',
  -- Prepared for a future hybrid (vector + lexical) retrieval function —
  -- unused by match_knowledge_chunks() this milestone, see plan notes.
  content_tsv tsvector generated always as (to_tsvector('french', content)) stored,
  created_at timestamptz not null default now()
);

-- hotel_id is denormalized on purpose (also reachable via source_id) so
-- every tenant-scoped filter — including inside match_knowledge_chunks() —
-- is a direct indexed equality check, never a join away from being forgotten.
create index knowledge_chunks_hotel_id_idx on public.knowledge_chunks (hotel_id);
create index knowledge_chunks_source_id_idx on public.knowledge_chunks (source_id);
create index knowledge_chunks_tsv_idx on public.knowledge_chunks using gin (content_tsv);

-- No ANN index (ivfflat/hnsw) yet: at this milestone's volume (a handful of
-- hotels, low hundreds of chunks) a sequential scan with the <=> operator
-- is fast and exact. Add one (hnsw recommended — no row-count tuning
-- needed, unlike ivfflat) once real chunk volume justifies the build cost.

-- =========================================================================
-- message_sources — which chunks actually grounded a given assistant reply
-- =========================================================================
create table public.message_sources (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages (id) on delete cascade,
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  source_id uuid not null references public.knowledge_sources (id) on delete cascade,
  chunk_id uuid not null references public.knowledge_chunks (id) on delete cascade,
  similarity_score real not null,
  created_at timestamptz not null default now()
);

create index message_sources_message_id_idx on public.message_sources (message_id);
create index message_sources_hotel_id_idx on public.message_sources (hotel_id);

-- =========================================================================
-- Row Level Security — same posture as every other business table in 0001:
-- superadmin only, via the existing public.is_superadmin() helper.
-- =========================================================================
alter table public.knowledge_chunks enable row level security;
alter table public.message_sources enable row level security;

create policy "superadmin full access" on public.knowledge_chunks
  for all using (public.is_superadmin()) with check (public.is_superadmin());

create policy "superadmin full access" on public.message_sources
  for all using (public.is_superadmin()) with check (public.is_superadmin());

-- =========================================================================
-- Data API grants — this project still has "expose new tables" disabled
-- (see 0001_init.sql's Data API grants section for the full rationale).
-- Same least-privilege posture: authenticated gets DML, anon gets nothing.
-- =========================================================================
grant select, insert, update, delete on public.knowledge_chunks to authenticated;
grant select, insert, update, delete on public.message_sources to authenticated;

revoke all on public.knowledge_chunks from anon;
revoke all on public.message_sources from anon;

-- =========================================================================
-- match_knowledge_chunks — the ONLY way the app performs vector retrieval.
-- The hotel_id filter lives inside this function's SQL body, not in
-- caller-supplied logic: there is no code path through this function that
-- skips it, regardless of how retrieveKnowledge() is called from the app.
-- Also filters to active, non-disabled sources so a superadmin disabling a
-- source immediately excludes it from retrieval.
-- =========================================================================
create or replace function public.match_knowledge_chunks(
  p_hotel_id uuid,
  p_query_embedding vector(1536),
  p_match_count int default 6
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_title text,
  content text,
  similarity double precision
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
    1 - (kc.embedding <=> p_query_embedding) as similarity
  from public.knowledge_chunks kc
  join public.knowledge_sources ks
    on ks.id = kc.source_id and ks.is_active
  where kc.hotel_id = p_hotel_id
  order by kc.embedding <=> p_query_embedding
  limit greatest(p_match_count, 1);
$$;

revoke all on function public.match_knowledge_chunks(uuid, vector, int) from public;
grant execute on function public.match_knowledge_chunks(uuid, vector, int) to authenticated;

-- =========================================================================
-- replace_knowledge_chunks — atomic swap for (re)indexing one source.
-- The app computes ALL new embeddings first (see features/rag/ingest.ts)
-- and only then calls this function, so a failed OpenAI call never leaves
-- a source half-reindexed: either every new chunk lands in the same
-- transaction as the delete of the old ones, or nothing changes at all.
-- =========================================================================
create or replace function public.replace_knowledge_chunks(
  p_source_id uuid,
  p_hotel_id uuid,
  p_chunks jsonb -- array of {content, embedding, chunk_index, token_count?, metadata?}
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  delete from public.knowledge_chunks
  where source_id = p_source_id and hotel_id = p_hotel_id;

  insert into public.knowledge_chunks (hotel_id, source_id, content, embedding, chunk_index, token_count, metadata)
  select
    p_hotel_id,
    p_source_id,
    chunk ->> 'content',
    (chunk ->> 'embedding')::vector,
    (chunk ->> 'chunk_index')::integer,
    nullif(chunk ->> 'token_count', '')::integer,
    coalesce(chunk -> 'metadata', '{}'::jsonb)
  from jsonb_array_elements(p_chunks) as chunk;
end;
$$;

revoke all on function public.replace_knowledge_chunks(uuid, uuid, jsonb) from public;
grant execute on function public.replace_knowledge_chunks(uuid, uuid, jsonb) to authenticated;
