-- Add a content hash column so duplicate documents are rejected at the DB level.
-- MD5 of raw_text is sufficient for deduplication (not a security use-case).
alter table documents
  add column if not exists content_hash text;

-- Backfill existing rows
update documents set content_hash = md5(raw_text) where content_hash is null;

-- Now enforce uniqueness going forward
alter table documents
  add constraint documents_content_hash_key unique (content_hash);

-- Make the column non-nullable for new inserts
alter table documents
  alter column content_hash set not null;
