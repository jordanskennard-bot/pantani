-- Let a caller ask only for recent knowledge, and tell every caller how old a
-- chunk's document is.
--
-- Why: /api/ideas looks for what is new. Its whole job is to surface features,
-- betas and tactics the knowledge base learnt about lately, so it needs a
-- recency window. Before this, search_knowledge returned no date at all, so a
-- caller could not filter on one even after over-fetching.
--
-- Two changes, both additive for existing callers:
--   filter_after   when set, only chunks whose document is newer are returned.
--                  Filtering here rather than in the caller means the whole
--                  match_count budget is spent on chunks inside the window,
--                  instead of fetching 24 and finding most of them too old.
--   document_date  the document's date, so a caller can show it and check the
--                  window itself.
--
-- The date is documents.created_at, which is when the document was ingested.
-- No published date is stored for any source type, so "recent" means recently
-- learnt rather than recently published. That is what the ideas route wants.
--
-- create or replace cannot change a function's return type, and adding a
-- column to returns table does change it, so the old function is dropped
-- first. The signature below is migration 006's exactly. The three existing
-- callers (/api/ask, /api/recommend, /api/knowledge) pass the same four named
-- arguments and are unaffected: filter_after defaults to null, which returns
-- what they returned before.

drop function if exists search_knowledge(vector(512), int, text, text[]);

create or replace function search_knowledge(
  query_embedding vector(512),
  match_count int default 8,
  filter_source_type text default null,
  filter_tags text[] default null,
  filter_after timestamptz default null
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
  document_date timestamptz,
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
    d.created_at as document_date,
    1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where
    (filter_source_type is null or d.source_type = filter_source_type)
    and (filter_tags is null or d.tags && filter_tags)
    and (filter_after is null or d.created_at >= filter_after)
    and c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- The window filter reads created_at on every candidate row, so it is worth an
-- index once the table is large.
create index if not exists documents_created_at_idx on documents (created_at desc);
