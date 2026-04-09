-- Replace search function to support tag filtering and return summary + context_prefix
create or replace function search_knowledge(
  query_embedding vector(1024),
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
