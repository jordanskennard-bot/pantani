-- Add key_insights array to documents
-- Stores 3-8 extracted facts/claims/stats per document for richer retrieval context
alter table documents
  add column if not exists key_insights text[] default '{}';

-- Update search_knowledge to return key_insights alongside summary
-- Also corrects the query_embedding type to vector(512) to match the actual column
create or replace function search_knowledge(
  query_embedding vector(512),
  match_count int default 8,
  filter_source_type text default null,
  filter_tags text[] default null
)
returns table (
  chunk_id uuid,
  document_id uuid,
  source_type text,
  source_ref text,
  title text,
  summary text,
  key_insights text[],
  tags text[],
  content text,
  context_prefix text,
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
    d.summary,
    d.key_insights,
    d.tags,
    c.content,
    c.context_prefix,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where
    (filter_source_type is null or d.source_type = filter_source_type)
    and (filter_tags is null or d.tags && filter_tags)
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
