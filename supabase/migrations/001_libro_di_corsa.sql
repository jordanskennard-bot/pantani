-- Enable pgvector extension
create extension if not exists vector;

-- Documents table — one row per ingested item (email, file, URL)
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source_type text not null check (source_type in ('email', 'file', 'url')),
  source_ref text,        -- filename, URL, or email subject
  source_from text,       -- sender email address (email source only)
  title text,
  raw_text text not null,
  token_count int,
  metadata jsonb default '{}'::jsonb
);

-- Chunks table — one row per chunk of a document, with its embedding
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(1024),   -- voyage-3-lite produces 1024-dim embeddings
  created_at timestamptz not null default now()
);

-- Index for fast cosine similarity search
create index if not exists chunks_embedding_idx
  on chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Search function: return top-k chunks by cosine similarity
create or replace function search_knowledge(
  query_embedding vector(1024),
  match_count int default 8,
  filter_source_type text default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  source_type text,
  source_ref text,
  title text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    c.id as chunk_id,
    d.id as document_id,
    d.source_type,
    d.source_ref,
    d.title,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where
    (filter_source_type is null or d.source_type = filter_source_type)
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
