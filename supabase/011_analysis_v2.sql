-- ============================================================================
-- 011 — HackSim V2 repository intelligence engine (relational storage)
-- Idempotent. Run after 010_analysis_v3.sql.
-- ============================================================================

-- ── Analysis run (orchestrator root) ────────────────────────────────────────

create table if not exists public.analysis_runs (
  id                  uuid primary key default gen_random_uuid(),
  submission_id       uuid not null references public.submissions (id) on delete cascade,
  repository_id       uuid references public.repositories (id) on delete set null,
  commit_sha          text not null,
  normalized_repo_url text,
  owner               text,
  repo_name           text,
  default_branch      text,
  scanner_version     text not null,
  analysis_version    text not null default 'v2',
  prompt_version      text,
  status              text not null default 'queued'
    check (status in (
      'queued', 'discovering_repository', 'scanning_repository',
      'building_code_graph', 'discovering_features', 'mapping_requirements',
      'verifying', 'validating', 'finalizing', 'completed', 'partial', 'failed'
    )),
  progress_stage      text,
  progress_percent    smallint check (progress_percent is null or (progress_percent >= 0 and progress_percent <= 100)),
  coverage_level      text check (coverage_level is null or coverage_level in ('high', 'medium', 'low')),
  error_code          text,
  error_message       text,
  started_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz
);

create unique index if not exists analysis_runs_cache_idx
  on public.analysis_runs (submission_id, commit_sha, scanner_version, analysis_version)
  where status in ('completed', 'partial');

create index if not exists analysis_runs_submission_idx
  on public.analysis_runs (submission_id, started_at desc);
create index if not exists analysis_runs_status_idx
  on public.analysis_runs (status) where status not in ('completed', 'failed', 'partial');

drop trigger if exists analysis_runs_touch on public.analysis_runs;
create trigger analysis_runs_touch
  before update on public.analysis_runs
  for each row execute function public.touch_updated_at();

alter table public.submissions
  add column if not exists latest_analysis_run_id uuid references public.analysis_runs (id) on delete set null;

-- ── Repository snapshot (commit freeze) ─────────────────────────────────────

create table if not exists public.repository_snapshots (
  id                uuid primary key default gen_random_uuid(),
  analysis_run_id   uuid not null unique references public.analysis_runs (id) on delete cascade,
  normalized_url    text not null,
  owner             text not null,
  repo_name         text not null,
  default_branch    text,
  commit_sha        text not null,
  is_private        boolean,
  primary_language  text,
  file_count        integer not null default 0,
  metadata          jsonb not null default '{}'::jsonb,
  started_at        timestamptz not null default now(),
  completed_at      timestamptz
);

create index if not exists repository_snapshots_commit_idx
  on public.repository_snapshots (owner, repo_name, commit_sha);

-- ── V2 file inventory ─────────────────────────────────────────────────────

create table if not exists public.v2_repository_files (
  id                uuid primary key default gen_random_uuid(),
  analysis_run_id   uuid not null references public.analysis_runs (id) on delete cascade,
  path              text not null,
  size_bytes        bigint not null default 0,
  extension         text,
  language          text,
  category          text not null default 'unknown',
  importance_score  numeric(5,4) not null default 0,
  importance_reasons jsonb not null default '[]'::jsonb,
  ignored           boolean not null default false,
  generated         boolean not null default false,
  binary            boolean not null default false,
  sensitive         boolean not null default false,
  content_hash      text,
  structurally_indexed boolean not null default false,
  functionally_inspected boolean not null default false,
  sent_to_ai        boolean not null default false,
  unique (analysis_run_id, path)
);

create index if not exists v2_files_run_idx on public.v2_repository_files (analysis_run_id);
create index if not exists v2_files_path_idx on public.v2_repository_files (analysis_run_id, path);

-- ── Symbols ─────────────────────────────────────────────────────────────────

create table if not exists public.v2_repository_symbols (
  id              uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.analysis_runs (id) on delete cascade,
  file_id         uuid not null references public.v2_repository_files (id) on delete cascade,
  symbol_key      text not null,
  name            text not null,
  symbol_type     text not null,
  language        text,
  start_line      integer not null,
  end_line        integer not null,
  signature       text,
  parent_symbol   text,
  importance      numeric(5,4) not null default 0,
  uncertain       boolean not null default false,
  unique (analysis_run_id, symbol_key)
);

create index if not exists v2_symbols_run_idx on public.v2_repository_symbols (analysis_run_id);
create index if not exists v2_symbols_file_idx on public.v2_repository_symbols (file_id);

-- ── Relationships ───────────────────────────────────────────────────────────

create table if not exists public.v2_code_relationships (
  id                uuid primary key default gen_random_uuid(),
  analysis_run_id   uuid not null references public.analysis_runs (id) on delete cascade,
  source_symbol_id  uuid references public.v2_repository_symbols (id) on delete cascade,
  target_symbol_id  uuid references public.v2_repository_symbols (id) on delete cascade,
  source_file_id    uuid references public.v2_repository_files (id) on delete cascade,
  target_file_id    uuid references public.v2_repository_files (id) on delete cascade,
  relationship_type text not null,
  confidence        text not null default 'medium'
    check (confidence in ('high', 'medium', 'low', 'uncertain')),
  source_file       text,
  source_lines      text,
  detail            jsonb not null default '{}'::jsonb
);

create index if not exists v2_rel_run_idx on public.v2_code_relationships (analysis_run_id);
create index if not exists v2_rel_type_idx on public.v2_code_relationships (analysis_run_id, relationship_type);
create index if not exists v2_rel_source_sym on public.v2_code_relationships (source_symbol_id);
create index if not exists v2_rel_target_sym on public.v2_code_relationships (target_symbol_id);

-- ── Features / workflows ────────────────────────────────────────────────────

create table if not exists public.v2_feature_candidates (
  id              uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.analysis_runs (id) on delete cascade,
  feature_key     text not null,
  name            text not null,
  workflow        jsonb not null default '[]'::jsonb,
  entry_symbol_ids uuid[] not null default '{}',
  symbol_ids      uuid[] not null default '{}',
  relationship_ids uuid[] not null default '{}',
  evidence_ids    text[] not null default '{}',
  confidence      text not null default 'medium',
  unique (analysis_run_id, feature_key)
);

create index if not exists v2_features_run_idx on public.v2_feature_candidates (analysis_run_id);

-- ── Evidence ────────────────────────────────────────────────────────────────

create table if not exists public.v2_evidence_items (
  id              uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.analysis_runs (id) on delete cascade,
  evidence_id     text not null,
  level           text not null
    check (level in ('metadata', 'structural', 'implementation', 'relationship', 'workflow', 'runtime')),
  evidence_type   text not null,
  claim           text not null,
  file_path       text,
  symbol_name     text,
  start_line      integer,
  end_line        integer,
  snippet_hash    text,
  snippet_excerpt text,
  confidence      text not null default 'medium',
  detail          jsonb not null default '{}'::jsonb,
  unique (analysis_run_id, evidence_id)
);

create index if not exists v2_evidence_run_idx on public.v2_evidence_items (analysis_run_id);
create index if not exists v2_evidence_level_idx on public.v2_evidence_items (analysis_run_id, level);

create table if not exists public.v2_evidence_chains (
  id              uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.analysis_runs (id) on delete cascade,
  chain_key       text not null,
  name            text,
  ordered_evidence_ids text[] not null,
  feature_id      uuid references public.v2_feature_candidates (id) on delete set null,
  unique (analysis_run_id, chain_key)
);

-- ── Requirements & claims ───────────────────────────────────────────────────

create table if not exists public.v2_requirement_links (
  id                    uuid primary key default gen_random_uuid(),
  analysis_run_id       uuid not null references public.analysis_runs (id) on delete cascade,
  requirement_id        text not null,
  kind                  text not null default 'requirement',
  status                text not null,
  confidence            text not null,
  explanation           text,
  uncertainties         jsonb not null default '[]'::jsonb,
  evidence_ids          text[] not null default '{}',
  workflow_ids          text[] not null default '{}',
  verification_result_id uuid,
  unique (analysis_run_id, requirement_id, kind)
);

create table if not exists public.v2_claim_verifications (
  id              uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.analysis_runs (id) on delete cascade,
  claim_text      text not null,
  status          text not null,
  confidence      text not null,
  explanation     text,
  evidence_ids    text[] not null default '{}',
  chain_keys      text[] not null default '{}'
);

-- ── DeepSeek verification ───────────────────────────────────────────────────

create table if not exists public.v2_verification_requests (
  id                uuid primary key default gen_random_uuid(),
  analysis_run_id   uuid not null references public.analysis_runs (id) on delete cascade,
  operation         text not null,
  model             text,
  prompt_version    text,
  packet_hash       text,
  evidence_hash     text,
  subject_ids       text[] not null default '{}',
  verification_round smallint not null default 1,
  input_tokens      integer not null default 0,
  output_tokens     integer not null default 0,
  cached_tokens     integer not null default 0,
  total_tokens      integer not null default 0,
  estimated_cost_usd numeric(12,6) not null default 0,
  duration_ms       integer not null default 0,
  cache_hit         boolean not null default false,
  status            text not null,
  error_code        text,
  created_at        timestamptz not null default now()
);

create index if not exists v2_verif_req_run_idx on public.v2_verification_requests (analysis_run_id);

create table if not exists public.v2_verification_results (
  id                      uuid primary key default gen_random_uuid(),
  request_id              uuid not null unique references public.v2_verification_requests (id) on delete cascade,
  verdict                 text not null,
  confidence              text,
  verification_level      text,
  summary                 text,
  supporting_evidence_ids text[] not null default '{}',
  missing_links           jsonb not null default '[]'::jsonb,
  contradictions          jsonb not null default '[]'::jsonb,
  additional_files_needed text[] not null default '{}',
  runtime_verified        boolean not null default false,
  verification_complete   boolean not null default true,
  raw_payload             jsonb,
  validated_at            timestamptz not null default now()
);

-- ── Coverage & stage events ─────────────────────────────────────────────────

create table if not exists public.v2_analysis_coverage (
  analysis_run_id           uuid primary key references public.analysis_runs (id) on delete cascade,
  files_discovered          integer not null default 0,
  files_structurally_indexed integer not null default 0,
  files_functionally_inspected integer not null default 0,
  files_sent_to_ai          integer not null default 0,
  symbols_indexed           integer not null default 0,
  relationships_found       integer not null default 0,
  evidence_items            integer not null default 0,
  evidence_chains           integer not null default 0,
  source_lines_inspected    integer not null default 0,
  requirements_analyzed     integer not null default 0,
  requirements_verified     integer not null default 0,
  ai_requests               integer not null default 0,
  ai_input_tokens           integer not null default 0,
  ai_output_tokens          integer not null default 0,
  ai_cached_tokens          integer not null default 0,
  ai_cost_usd               numeric(12,6) not null default 0
);

create table if not exists public.v2_analysis_stage_events (
  id              uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.analysis_runs (id) on delete cascade,
  stage           text not null,
  message         text,
  metrics         jsonb not null default '{}'::jsonb,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);

create index if not exists v2_stage_events_run_idx
  on public.v2_analysis_stage_events (analysis_run_id, created_at);

create table if not exists public.v2_analysis_errors (
  id              uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references public.analysis_runs (id) on delete cascade,
  stage           text,
  code            text,
  message         text not null,
  detail          jsonb,
  created_at      timestamptz not null default now()
);

-- ── Executive summary (report cache) ────────────────────────────────────────

create table if not exists public.v2_analysis_summaries (
  analysis_run_id uuid primary key references public.analysis_runs (id) on delete cascade,
  headline        text,
  implementation_summary text,
  strong_points   jsonb not null default '[]'::jsonb,
  uncertainties   jsonb not null default '[]'::jsonb,
  defense_questions jsonb not null default '[]'::jsonb,
  updated_at      timestamptz not null default now()
);

-- ── RLS ─────────────────────────────────────────────────────────────────────

alter table public.analysis_runs enable row level security;
alter table public.repository_snapshots enable row level security;
alter table public.v2_repository_files enable row level security;
alter table public.v2_repository_symbols enable row level security;
alter table public.v2_code_relationships enable row level security;
alter table public.v2_feature_candidates enable row level security;
alter table public.v2_evidence_items enable row level security;
alter table public.v2_evidence_chains enable row level security;
alter table public.v2_requirement_links enable row level security;
alter table public.v2_claim_verifications enable row level security;
alter table public.v2_verification_requests enable row level security;
alter table public.v2_verification_results enable row level security;
alter table public.v2_analysis_coverage enable row level security;
alter table public.v2_analysis_stage_events enable row level security;
alter table public.v2_analysis_errors enable row level security;
alter table public.v2_analysis_summaries enable row level security;

-- Helper: user may read V2 data for submissions they own (or admin)
create or replace function public.v2_can_read_run(p_run_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
    or exists (
      select 1 from public.analysis_runs ar
      where ar.id = p_run_id
        and public.owns_submission(ar.submission_id)
    );
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'analysis_runs', 'repository_snapshots', 'v2_repository_files',
    'v2_repository_symbols', 'v2_code_relationships', 'v2_feature_candidates',
    'v2_evidence_items', 'v2_evidence_chains', 'v2_requirement_links',
    'v2_claim_verifications', 'v2_verification_requests', 'v2_verification_results',
    'v2_analysis_coverage', 'v2_analysis_stage_events', 'v2_analysis_errors',
    'v2_analysis_summaries'
  ] loop
    execute format('drop policy if exists v2_read_%I on public.%I', t, t);
    if t = 'analysis_runs' then
      execute format(
        'create policy v2_read_%I on public.%I for select using (
          public.is_admin() or public.owns_submission(submission_id)
        )', t, t);
    elsif t = 'repository_snapshots' then
      execute format(
        'create policy v2_read_%I on public.%I for select using (
          public.v2_can_read_run(analysis_run_id)
        )', t, t);
    else
      execute format(
        'create policy v2_read_%I on public.%I for select using (
          public.v2_can_read_run(analysis_run_id)
        )', t, t);
    end if;
  end loop;
end $$;

-- Service role writes only (edge functions use service client)

-- ── RPC: latest run status (student polling) ────────────────────────────────

create or replace function public.analysis_run_status(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_admin boolean := public.is_admin();
begin
  if not (v_admin or public.owns_submission(p_submission_id)) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  return (
    select jsonb_build_object(
      'run_id', ar.id,
      'status', ar.status,
      'progress_stage', ar.progress_stage,
      'progress_percent', ar.progress_percent,
      'coverage_level', ar.coverage_level,
      'commit_sha', ar.commit_sha,
      'error_code', ar.error_code,
      'error_message', ar.error_message,
      'started_at', ar.started_at,
      'updated_at', ar.updated_at,
      'completed_at', ar.completed_at,
      'engine', 'v2'
    )
    from public.analysis_runs ar
    where ar.submission_id = p_submission_id
    order by ar.started_at desc
    limit 1
  );
end;
$$;

-- ── RPC: V2 report summary ──────────────────────────────────────────────────

create or replace function public.v2_analysis_summary(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_run_id uuid;
begin
  if not (public.is_admin() or public.owns_submission(p_submission_id)) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  select ar.id into v_run_id
  from public.analysis_runs ar
  where ar.submission_id = p_submission_id
    and ar.status in ('completed', 'partial')
  order by ar.completed_at desc nulls last, ar.started_at desc
  limit 1;

  if v_run_id is null then
    return jsonb_build_object('ready', false);
  end if;

  return jsonb_build_object(
    'ready', true,
    'run_id', v_run_id,
    'run', (select to_jsonb(ar) from public.analysis_runs ar where ar.id = v_run_id),
    'snapshot', (select to_jsonb(s) from public.repository_snapshots s where s.analysis_run_id = v_run_id),
    'coverage', (select to_jsonb(c) from public.v2_analysis_coverage c where c.analysis_run_id = v_run_id),
    'summary', (select to_jsonb(su) from public.v2_analysis_summaries su where su.analysis_run_id = v_run_id),
    'requirements', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.requirement_id), '[]'::jsonb)
      from public.v2_requirement_links r where r.analysis_run_id = v_run_id
    ),
    'claims', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.claim_text), '[]'::jsonb)
      from public.v2_claim_verifications c where c.analysis_run_id = v_run_id
    ),
    'features', (
      select coalesce(jsonb_agg(to_jsonb(f) order by f.feature_key), '[]'::jsonb)
      from public.v2_feature_candidates f where f.analysis_run_id = v_run_id
    )
  );
end;
$$;

-- Paginated evidence
create or replace function public.v2_analysis_evidence_page(
  p_run_id uuid,
  p_limit integer default 25,
  p_offset integer default 0,
  p_level text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.v2_can_read_run(p_run_id) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  return jsonb_build_object(
    'items', (
      select coalesce(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
      from (
        select * from public.v2_evidence_items e
        where e.analysis_run_id = p_run_id
          and (p_level is null or e.level = p_level)
        order by e.evidence_id
        limit greatest(1, least(p_limit, 100))
        offset greatest(0, p_offset)
      ) e
    ),
    'total', (
      select count(*) from public.v2_evidence_items e
      where e.analysis_run_id = p_run_id
        and (p_level is null or e.level = p_level)
    )
  );
end;
$$;

-- V2 report data is loaded via public.v2_analysis_summary and public.analysis_run_status.
-- submission_analysis (010) remains the legacy payload; the API merges v2 fields in the edge GET handler.
