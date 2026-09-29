-- 012 — V2 completion: verification cache, checkpoints, richer RPCs

alter table public.analysis_runs
  add column if not exists checkpoint jsonb not null default '{}'::jsonb;

create table if not exists public.v2_verification_cache (
  cache_key           text primary key,
  commit_sha          text not null,
  analysis_version    text not null,
  scanner_version     text not null,
  prompt_version      text not null,
  model               text,
  operation           text not null,
  subject_hash        text,
  claim_hash          text,
  evidence_hash       text not null,
  packet_hash         text not null,
  validated_result    jsonb not null,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cached_tokens       integer not null default 0,
  estimated_cost_usd  numeric(12,6) not null default 0,
  status              text not null default 'success',
  created_at          timestamptz not null default now()
);

create index if not exists v2_verification_cache_lookup_idx
  on public.v2_verification_cache (commit_sha, analysis_version, prompt_version, operation);

alter table public.v2_verification_cache enable row level security;
drop policy if exists v2_verification_cache_admin on public.v2_verification_cache;
create policy v2_verification_cache_admin on public.v2_verification_cache
  for select using (public.is_admin());

create or replace function public.v2_analysis_evidence_page(
  p_run_id uuid,
  p_limit integer default 25,
  p_offset integer default 0,
  p_level text default null,
  p_type text default null,
  p_file text default null,
  p_search text default null,
  p_confidence text default null
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.v2_can_read_run(p_run_id) then
    raise exception 'You are not authorized to perform this action.';
  end if;
  return jsonb_build_object(
    'items', (
      select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb) from (
        select evidence_id, level, evidence_type, claim, file_path, symbol_name,
               start_line, end_line, confidence, snippet_excerpt, detail
        from public.v2_evidence_items e
        where e.analysis_run_id = p_run_id
          and (p_level is null or e.level = p_level)
          and (p_type is null or e.evidence_type = p_type)
          and (p_confidence is null or e.confidence = p_confidence)
          and (p_file is null or e.file_path ilike '%' || p_file || '%')
          and (p_search is null or e.claim ilike '%' || p_search || '%'
               or coalesce(e.file_path,'') ilike '%' || p_search || '%')
        order by e.evidence_id
        limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
      ) e
    ),
    'total', (
      select count(*) from public.v2_evidence_items e
      where e.analysis_run_id = p_run_id
        and (p_level is null or e.level = p_level)
        and (p_type is null or e.evidence_type = p_type)
        and (p_confidence is null or e.confidence = p_confidence)
        and (p_file is null or e.file_path ilike '%' || p_file || '%')
        and (p_search is null or e.claim ilike '%' || p_search || '%'
             or coalesce(e.file_path,'') ilike '%' || p_search || '%')
    )
  );
end;
$$;

create or replace function public.v2_analysis_relationships_page(
  p_run_id uuid,
  p_limit integer default 50,
  p_offset integer default 0,
  p_type text default null
)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.v2_can_read_run(p_run_id) then raise exception 'Unauthorized'; end if;
  return jsonb_build_object(
    'items', (
      select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from (
        select id, relationship_type, confidence, source_file, source_lines, detail
        from public.v2_code_relationships
        where analysis_run_id = p_run_id
          and (p_type is null or relationship_type = p_type)
        order by relationship_type, source_file
        limit least(p_limit, 200) offset greatest(0, p_offset)
      ) r
    ),
    'total', (
      select count(*) from public.v2_code_relationships
      where analysis_run_id = p_run_id
        and (p_type is null or relationship_type = p_type)
    )
  );
end;
$$;

create or replace function public.v2_evidence_detail(p_run_id uuid, p_evidence_id text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.v2_can_read_run(p_run_id) then raise exception 'Unauthorized'; end if;
  return (
    select to_jsonb(e) from public.v2_evidence_items e
    where e.analysis_run_id = p_run_id and e.evidence_id = p_evidence_id
    limit 1
  );
end;
$$;
