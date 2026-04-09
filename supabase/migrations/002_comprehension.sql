-- Add comprehension fields to documents
alter table documents
  add column if not exists summary text,
  add column if not exists tags text[] default '{}';

-- Add context prefix to chunks (prepended before embedding for better retrieval)
alter table chunks
  add column if not exists context_prefix text;

-- Index for tag filtering
create index if not exists documents_tags_idx on documents using gin (tags);
