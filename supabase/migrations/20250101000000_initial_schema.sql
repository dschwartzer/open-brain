-- Open Brain: Initial Schema
-- Extensions, tables, indexes, RLS, and functions

-- ============================================================
-- Extensions
-- ============================================================

create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists "vector" with schema extensions;

-- ============================================================
-- Tables
-- ============================================================

-- Personal thoughts / captures
create table public.thoughts (
  id              uuid primary key default gen_random_uuid(),
  content         text not null,
  embedding       vector(1536),
  type            text default 'note',
  category        text,
  source          text default 'mcp',
  people          text[] default '{}',
  action_items    text[] default '{}',
  topics          text[] default '{}',
  metadata        jsonb default '{}',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  idempotency_key text unique
);

-- Knowledge base: collections → documents → chunks
create table public.collections (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  source_type text not null,
  language    text default 'en',
  metadata    jsonb default '{}',
  created_at  timestamptz default now()
);

create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  collection_id uuid references collections(id) on delete cascade,
  title         text not null,
  content       text not null,
  source_url    text,
  author        text,
  language      text default 'en',
  metadata      jsonb default '{}',
  created_at    timestamptz default now()
);

create table public.chunks (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid references documents(id) on delete cascade,
  collection_id uuid references collections(id) on delete cascade,
  content       text not null,
  embedding     vector(1536),
  chunk_index   integer not null,
  metadata      jsonb default '{}',
  created_at    timestamptz default now()
);

-- ============================================================
-- Indexes
-- ============================================================

-- Thoughts
create index thoughts_embedding_idx on thoughts using hnsw (embedding vector_cosine_ops);
create index thoughts_type_idx on thoughts using btree (type);
create index thoughts_created_at_idx on thoughts using btree (created_at desc);

-- Documents
create index documents_collection_id_idx on documents using btree (collection_id);
create index documents_created_at_idx on documents using btree (created_at desc);

-- Chunks
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index chunks_collection_id_idx on chunks using btree (collection_id);
create index chunks_document_id_idx on chunks using btree (document_id);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table thoughts enable row level security;
alter table collections enable row level security;
alter table documents enable row level security;
alter table chunks enable row level security;

create policy "Service role full access" on thoughts for all using (auth.role() = 'service_role');
create policy "Service role full access" on collections for all using (auth.role() = 'service_role');
create policy "Service role full access" on documents for all using (auth.role() = 'service_role');
create policy "Service role full access" on chunks for all using (auth.role() = 'service_role');

-- ============================================================
-- Functions
-- ============================================================

-- Semantic search over personal thoughts
create or replace function public.match_thoughts(
  query_embedding vector,
  match_threshold double precision default 0.3,
  match_count integer default 10
)
returns table (
  id uuid,
  content text,
  type text,
  category text,
  source text,
  people text[],
  action_items text[],
  topics text[],
  metadata jsonb,
  similarity double precision,
  created_at timestamptz
)
language plpgsql as $$
begin
  return query
  select
    t.id, t.content, t.type, t.category, t.source,
    t.people, t.action_items, t.topics, t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Semantic search over knowledge base chunks (basic)
create or replace function public.match_chunks(
  query_embedding vector,
  match_threshold double precision default 0.3,
  match_count integer default 10,
  filter_collection_id uuid default null
)
returns table (
  id uuid,
  content text,
  chunk_index integer,
  similarity double precision,
  document_id uuid,
  document_title text,
  collection_id uuid,
  collection_name text,
  metadata jsonb
)
language plpgsql as $$
begin
  return query
  select
    ch.id, ch.content, ch.chunk_index,
    1 - (ch.embedding <=> query_embedding) as similarity,
    d.id as document_id,
    d.title as document_title,
    c.id as collection_id,
    c.name as collection_name,
    ch.metadata
  from chunks ch
  join documents d on d.id = ch.document_id
  join collections c on c.id = ch.collection_id
  where 1 - (ch.embedding <=> query_embedding) > match_threshold
    and (filter_collection_id is null or ch.collection_id = filter_collection_id)
  order by ch.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Semantic search with recency boost + date filters
create or replace function public.match_chunks_with_recency(
  query_embedding vector,
  match_threshold double precision default 0.25,
  match_count integer default 10,
  filter_collection_id uuid default null,
  recency_weight double precision default 0.0,
  after_date timestamptz default null,
  before_date timestamptz default null
)
returns table (
  id uuid,
  content text,
  chunk_index integer,
  similarity double precision,
  final_score double precision,
  document_id uuid,
  document_title text,
  collection_id uuid,
  collection_name text,
  metadata jsonb,
  created_at timestamptz
)
language plpgsql as $$
declare
  max_age_days float;
begin
  -- Calculate max age for normalization
  select extract(epoch from (now() - min(ch.created_at))) / 86400.0
  into max_age_days
  from chunks ch;

  if max_age_days is null or max_age_days < 1 then
    max_age_days := 1;
  end if;

  return query
  select
    ch.id, ch.content, ch.chunk_index,
    (1 - (ch.embedding <=> query_embedding))::float as similarity,
    (
      (1 - (ch.embedding <=> query_embedding)) * (1.0 + recency_weight * (1.0 - extract(epoch from (now() - ch.created_at)) / 86400.0 / max_age_days))
    )::float as final_score,
    d.id as document_id,
    d.title as document_title,
    c.id as collection_id,
    c.name as collection_name,
    ch.metadata,
    ch.created_at
  from chunks ch
  join documents d on d.id = ch.document_id
  join collections c on c.id = ch.collection_id
  where (1 - (ch.embedding <=> query_embedding)) > match_threshold
    and (filter_collection_id is null or ch.collection_id = filter_collection_id)
    and (after_date is null or ch.created_at >= after_date)
    and (before_date is null or ch.created_at <= before_date)
  order by final_score desc
  limit match_count;
end;
$$;
