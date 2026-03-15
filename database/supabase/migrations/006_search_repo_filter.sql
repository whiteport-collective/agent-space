-- 006: Add repo filter to search functions

-- Update semantic search to support repo filtering
create or replace function search_design_space(
  query_embedding vector(1536),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_designer text default null,
  filter_repo text default null
)
returns table (
  id uuid,
  content text,
  category text,
  project text,
  repo text,
  designer text,
  client text,
  topics text[],
  components text[],
  source text,
  source_file text,
  pattern_type text,
  quality_score numeric,
  pair_id uuid,
  metadata jsonb,
  thread_id uuid,
  created_at timestamptz,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    ds.id,
    ds.content,
    ds.category,
    ds.project,
    ds.repo,
    ds.designer,
    ds.client,
    ds.topics,
    ds.components,
    ds.source,
    ds.source_file,
    ds.pattern_type,
    ds.quality_score,
    ds.pair_id,
    ds.metadata,
    ds.thread_id,
    ds.created_at,
    1 - (ds.embedding <=> query_embedding) as similarity
  from public.design_space ds
  where
    ds.embedding is not null
    and 1 - (ds.embedding <=> query_embedding) > similarity_threshold
    and (filter_category is null or ds.category = filter_category)
    and (filter_project is null or ds.project = filter_project)
    and (filter_designer is null or ds.designer = filter_designer)
    and (filter_repo is null or ds.repo = filter_repo)
  order by ds.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Update visual search to support repo filtering
create or replace function search_visual_similarity(
  query_embedding vector(1024),
  similarity_threshold float,
  match_count int,
  filter_category text default null,
  filter_project text default null,
  filter_pattern_type text default null,
  filter_repo text default null
)
returns table (
  id uuid,
  content text,
  category text,
  project text,
  repo text,
  designer text,
  pattern_type text,
  pair_id uuid,
  created_at timestamptz,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    ds.id,
    ds.content,
    ds.category,
    ds.project,
    ds.repo,
    ds.designer,
    ds.pattern_type,
    ds.pair_id,
    ds.created_at,
    1 - (ds.visual_embedding <=> query_embedding) as similarity
  from public.design_space ds
  where
    ds.visual_embedding is not null
    and 1 - (ds.visual_embedding <=> query_embedding) > similarity_threshold
    and (filter_category is null or ds.category = filter_category)
    and (filter_project is null or ds.project = filter_project)
    and (filter_pattern_type is null or ds.pattern_type = filter_pattern_type)
    and (filter_repo is null or ds.repo = filter_repo)
  order by ds.visual_embedding <=> query_embedding
  limit match_count;
end;
$$;
