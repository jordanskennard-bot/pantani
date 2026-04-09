-- Add 'youtube' as a valid source type
alter table documents drop constraint documents_source_type_check;
alter table documents add constraint documents_source_type_check
  check (source_type in ('email', 'file', 'url', 'youtube'));
