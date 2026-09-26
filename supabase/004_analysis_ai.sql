-- ============================================================================
-- 004 — Phase 5 (repository analysis) + Phase 6 (AI review)
-- ============================================================================
-- Run after 003_submissions.sql. Every statement is idempotent.
--
-- Design rules encoded here:
--   * The AI is never the source of truth. Repository evidence is. AI output
--     lives in ai_analyses.result and project_reviews, always traceable to
--     evidence ids produced by the deterministic scanner.
--   * Students can read their own analysis and nothing else. Every AI table is
--     locked to admin; students reach their data through SECURITY DEFINER
--     functions that re-check team membership.
--   * No secret is ever stored: secret evidence keeps a type, a location and a
--     redacted preview, never the matched value.
--
-- Two columns are added to `repositories` beyond the phase spec:
--   project_map jsonb — the compact map from §27, the primary Phase 6 input
--   evidence     jsonb — the evidence array from §26, so evidence ids in
--                       requirement_evaluations/findings stay resolvable
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- repositories — one analysed GitHub repository per submission
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.repositories (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid        not null unique
                                   references public.submissions (id) on delete cascade,

  github_url           text        not null,
  owner                text,
  repo_name            text,

  default_branch       text,
  latest_commit_sha    text,
  analyzed_commit_sha  text,

  visibility           text,
  language             text,
  stars                integer,
  forks                integer,

  analysis_status      text        not null default 'pending'
                                   check (analysis_status in
                                     ('pending', 'scanning', 'completed',
                                      'failed', 'stale', 'limited')),
  analysis_version     text,
  analysis_mode        text        not null default 'full'
                                   check (analysis_mode in ('full', 'limited')),

  project_map          jsonb,
  evidence             jsonb,

  file_count           integer     not null default 0,
  chunk_count          integer     not null default 0,
  secret_count         integer     not null default 0,

  error_code           text,
  error_message        text,

  last_analyzed_at     timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on table public.repositories is
  'Phase 5 output. project_map and evidence are the source of truth for Phase 6.';

create index if not exists repositories_status_idx  on public.repositories (analysis_status);
create index if not exists repositories_commit_idx  on public.repositories (analyzed_commit_sha);
create index if not exists repositories_updated_idx  on public.repositories (updated_at desc);

-- The commit-based cache key from §13. One scan per (submission, commit,
-- scanner version); a repeat run reuses the stored analysis.
create unique index if not exists repositories_cache_identity
  on public.repositories (submission_id, coalesce(analyzed_commit_sha, ''),
                         coalesce(analysis_version, ''));

drop trigger if exists repositories_touch on public.repositories;
create trigger repositories_touch
  before update on public.repositories
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- repository_files — the file inventory
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.repository_files (
  id             uuid primary key default gen_random_uuid(),
  repository_id  uuid        not null references public.repositories (id) on delete cascade,

  path           text        not null,
  file_name      text,
  extension      text,
  language       text,

  file_size      integer,
  line_count     integer,

  is_binary      boolean     not null default false,
  is_ignored     boolean     not null default false,

  file_category  text,
  importance     text,

  sha            text,

  created_at     timestamptz not null default now(),
  unique (repository_id, path)
);

create index if not exists repository_files_repo_idx on public.repository_files (repository_id);
create index if not exists repository_files_cat_idx  on public.repository_files (file_category);
create index if not exists repository_files_imp_idx  on public.repository_files (importance);


-- ────────────────────────────────────────────────────────────────────────────
-- code_chunks — only for files that matter, never the whole repository
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.code_chunks (
  id             uuid primary key default gen_random_uuid(),
  repository_id  uuid        not null references public.repositories (id) on delete cascade,
  file_id        uuid        not null references public.repository_files (id) on delete cascade,

  chunk_index    integer     not null,
  start_line     integer,
  end_line       integer,
  content        text,

  symbol_name    text,
  symbol_type    text,
  language       text,
  importance     text,

  created_at     timestamptz not null default now(),
  unique (file_id, chunk_index)
);

create index if not exists code_chunks_repo_idx   on public.code_chunks (repository_id);
create index if not exists code_chunks_file_idx   on public.code_chunks (file_id);
create index if not exists code_chunks_symbol_idx on public.code_chunks (symbol_name);


-- ────────────────────────────────────────────────────────────────────────────
-- ai_model_configs — pricing lives in the database, never in code
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.ai_model_configs (
  id                                   uuid primary key default gen_random_uuid(),
  provider                             text        not null,
  model_name                           text        not null,

  enabled                              boolean     not null default true,
  is_default                           boolean     not null default false,

  input_price_per_million_cache_hit    numeric(12, 6) not null default 0,
  input_price_per_million_cache_miss   numeric(12, 6) not null default 0,
  output_price_per_million             numeric(12, 6) not null default 0,

  max_input_tokens                     integer     not null default 32000,
  max_output_tokens                    integer     not null default 4000,

  reasoning_mode                       text        not null default 'off'
                                                 check (reasoning_mode in
                                                   ('off', 'low', 'medium', 'high')),

  created_at                           timestamptz not null default now(),
  updated_at                           timestamptz not null default now(),
  unique (provider, model_name)
);

create index if not exists ai_model_configs_default_idx
  on public.ai_model_configs (is_default) where is_default;

drop trigger if exists ai_model_configs_touch on public.ai_model_configs;
create trigger ai_model_configs_touch
  before update on public.ai_model_configs
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- ai_budgets — global, per-user and per-submission ceilings
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.ai_budgets (
  id                   uuid primary key default gen_random_uuid(),
  scope                text        not null check (scope in ('global', 'user', 'submission')),

  user_id              uuid references public.profiles (id) on delete cascade,
  submission_id        uuid references public.submissions (id) on delete cascade,

  -- A NULL scope target is the "global" row; the others are per-target.
  max_cost_usd         numeric(12, 6),
  max_input_tokens     bigint,
  max_output_tokens    bigint,
  max_requests         integer,

  used_cost_usd        numeric(14, 6) not null default 0,
  used_input_tokens    bigint      not null default 0,
  used_output_tokens   bigint      not null default 0,
  used_requests        integer     not null default 0,

  enabled              boolean     not null default true,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists ai_budgets_scope_idx  on public.ai_budgets (scope);
create index if not exists ai_budgets_user_idx   on public.ai_budgets (user_id);
create index if not exists ai_budgets_sub_idx    on public.ai_budgets (submission_id);

drop trigger if exists ai_budgets_touch on public.ai_budgets;
create trigger ai_budgets_touch
  before update on public.ai_budgets
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- ai_analyses — the AI cache (§58 identity) and the result store
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.ai_analyses (
  id                   uuid primary key default gen_random_uuid(),

  repository_id        uuid references public.repositories (id) on delete cascade,
  submission_id        uuid references public.submissions (id) on delete cascade,

  analysis_type        text        not null,
  scope_key            text,

  provider             text        not null,
  model                text        not null,
  model_version        text,

  prompt_version       text        not null,

  input_hash           text,
  context_hash         text,

  input_tokens         integer,
  output_tokens        integer,
  total_tokens         integer,

  cached_tokens        integer     not null default 0,
  cache_miss_tokens    integer     not null default 0,

  estimated_cost_usd   numeric(14, 8) not null default 0,

  result               jsonb,

  status               text        not null default 'pending'
                                   check (status in
                                     ('pending', 'success', 'failed', 'skipped', 'cached')),

  error_code           text,
  error_message        text,

  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);

create index if not exists ai_analyses_repo_idx    on public.ai_analyses (repository_id);
create index if not exists ai_analyses_sub_idx     on public.ai_analyses (submission_id);
create index if not exists ai_analyses_type_idx    on public.ai_analyses (analysis_type);
create index if not exists ai_analyses_created_idx on public.ai_analyses (created_at desc);

-- §58 cache identity is created near the end of this file, after
-- hackathon_requirement_maps — see ai_analyses_cache_identity below.


-- ────────────────────────────────────────────────────────────────────────────
-- ai_usage — the accounting ledger. One row per API request, always.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.ai_usage (
  id                   uuid primary key default gen_random_uuid(),

  user_id              uuid references public.profiles (id) on delete set null,
  submission_id        uuid references public.submissions (id) on delete cascade,
  repository_id        uuid references public.repositories (id) on delete cascade,
  session_id           uuid references public.build_sessions (id) on delete set null,

  operation            text        not null,

  provider             text        not null,
  model                text        not null,

  prompt_version       text,

  input_tokens         integer     not null default 0,
  output_tokens        integer     not null default 0,
  total_tokens         integer     not null default 0,
  cached_tokens        integer     not null default 0,
  cache_miss_tokens    integer     not null default 0,

  estimated_cost_usd   numeric(14, 8) not null default 0,

  request_id           text,
  status               text        not null default 'pending'
                                   check (status in
                                     ('pending', 'success', 'failed', 'rejected')),

  error_code           text,
  error_message        text,

  duration_ms          integer,

  created_at           timestamptz not null default now()
);

create index if not exists ai_usage_created_idx    on public.ai_usage (created_at desc);
create index if not exists ai_usage_submission_idx on public.ai_usage (submission_id);
create index if not exists ai_usage_user_idx       on public.ai_usage (user_id);
create index if not exists ai_usage_operation_idx  on public.ai_usage (operation);
create index if not exists ai_usage_status_idx     on public.ai_usage (status);


-- ────────────────────────────────────────────────────────────────────────────
-- hackathon_requirement_maps — the brief turned into stable requirement ids
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.hackathon_requirement_maps (
  id                   uuid primary key default gen_random_uuid(),
  hackathon_id         uuid        not null references public.hackathons (id) on delete cascade,

  version              integer     not null default 1,

  -- Hash of the source brief fields. Lets us reuse a cached map and only
  -- rebuild when the hackathon text actually changed (§31).
  input_hash           text,

  problem_summary      text,

  requirements         jsonb       not null default '[]'::jsonb,
  constraints          jsonb       not null default '[]'::jsonb,
  expected_outcomes    jsonb       not null default '[]'::jsonb,
  evaluation_criteria  jsonb       not null default '[]'::jsonb,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (hackathon_id, version)
);

create index if not exists hackathon_requirement_maps_h_idx
  on public.hackathon_requirement_maps (hackathon_id, version desc);

drop trigger if exists hackathon_requirement_maps_touch on public.hackathon_requirement_maps;
create trigger hackathon_requirement_maps_touch
  before update on public.hackathon_requirement_maps
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- requirement_evaluations — one row per requirement per submission
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.requirement_evaluations (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid        not null references public.submissions (id) on delete cascade,
  requirement_id       text        not null,

  status               text        not null default 'unable_to_determine'
                                   check (status in
                                     ('evidence_found', 'partial_evidence',
                                      'not_evidenced', 'unable_to_determine')),

  evidence_ids         text[]      not null default '{}',
  confidence           text        not null default 'low'
                                   check (confidence in
                                     ('high', 'medium', 'low', 'none')),

  explanation          text,

  source               text        not null default 'ai'
                                   check (source in ('deterministic', 'ai', 'skipped')),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (submission_id, requirement_id)
);

create index if not exists requirement_evaluations_sub_idx
  on public.requirement_evaluations (submission_id);
create index if not exists requirement_evaluations_status_idx
  on public.requirement_evaluations (status);

drop trigger if exists requirement_evaluations_touch on public.requirement_evaluations;
create trigger requirement_evaluations_touch
  before update on public.requirement_evaluations
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- project_reviews + findings
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.project_reviews (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid        not null references public.submissions (id) on delete cascade,
  repository_id        uuid        not null references public.repositories (id) on delete cascade,

  summary              jsonb,
  problem_alignment    jsonb,
  requirements         jsonb,
  constraints          jsonb,
  expected_outcomes    jsonb,
  evaluation_criteria  jsonb,

  architecture         jsonb,
  implementation       jsonb,
  security             jsonb,
  database_review      jsonb,
  testing              jsonb,
  scalability          jsonb,
  technical_decisions  jsonb,

  contributions        jsonb,

  status               text        not null default 'pending'
                                   check (status in
                                     ('pending', 'running', 'partial', 'completed', 'failed')),

  model                text,
  prompt_version       text,

  estimated_cost_usd   numeric(14, 8) not null default 0,
  total_tokens         integer     not null default 0,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (submission_id, repository_id)
);

create index if not exists project_reviews_sub_idx    on public.project_reviews (submission_id);
create index if not exists project_reviews_status_idx on public.project_reviews (status);

drop trigger if exists project_reviews_touch on public.project_reviews;
create trigger project_reviews_touch
  before update on public.project_reviews
  for each row execute function public.touch_updated_at();


create table if not exists public.project_review_findings (
  id                     uuid primary key default gen_random_uuid(),
  project_review_id      uuid        not null references public.project_reviews (id) on delete cascade,

  finding_type           text        not null check (finding_type in
                             ('strength', 'observation', 'potential_issue',
                              'confirmed_issue', 'security_concern', 'testing_gap',
                              'architecture_concern', 'scalability_concern',
                              'claim_mismatch', 'clarification_needed')),

  severity               text        not null default 'low' check (severity in
                             ('critical', 'high', 'medium', 'low', 'informational')),

  title                  text        not null,
  description            text,

  evidence_ids           text[]      not null default '{}',
  files                  text[]      not null default '{}',
  symbols                text[]      not null default '{}',

  why_it_matters         text,
  suggested_improvement  text,

  confidence             text        not null default 'low' check (confidence in
                             ('high', 'medium', 'low')),

  created_at             timestamptz not null default now()
);

create index if not exists project_review_findings_review_idx
  on public.project_review_findings (project_review_id);
create index if not exists project_review_findings_type_idx
  on public.project_review_findings (finding_type);
create index if not exists project_review_findings_severity_idx
  on public.project_review_findings (severity);


-- ────────────────────────────────────────────────────────────────────────────
-- defense_targets — topics to defend later. NOT questions (§50).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.defense_targets (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid        not null references public.submissions (id) on delete cascade,
  user_id              uuid references public.profiles (id) on delete cascade,

  topic                text        not null,
  reason               text,

  priority             text        not null default 'P3' check (priority in
                                   ('P0', 'P1', 'P2', 'P3', 'P4', 'P5')),

  evidence_ids         text[]      not null default '{}',

  question_area        text,

  status               text        not null default 'open' check (status in
                                   ('open', 'ready', 'dismissed')),

  created_at           timestamptz not null default now()
);

create index if not exists defense_targets_sub_idx  on public.defense_targets (submission_id);
create index if not exists defense_targets_user_idx on public.defense_targets (user_id);
create index if not exists defense_targets_pri_idx  on public.defense_targets (priority);


-- ────────────────────────────────────────────────────────────────────────────
-- AI cache identity
-- ────────────────────────────────────────────────────────────────────────────
-- The identity from §58: repository + analysis type + prompt version +
-- context hash + model. A row under this key is reused without a new request.

create unique index if not exists ai_analyses_cache_identity
  on public.ai_analyses (
    coalesce(repository_id, submission_id, gen_random_uuid()::uuid),
    analysis_type,
    prompt_version,
    coalesce(context_hash, ''),
    model
  )
  where status in ('success', 'cached');

comment on index public.ai_analyses_cache_identity is
  '§58 cache identity: repo + analysis type + prompt version + context hash + model.';


-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ────────────────────────────────────────────────────────────────────────────
-- Students never query these tables directly. They get their own analysis
-- through the SECURITY DEFINER functions below, which re-check membership.

alter table public.repositories           enable row level security;
alter table public.repository_files       enable row level security;
alter table public.code_chunks            enable row level security;
alter table public.ai_analyses            enable row level security;
alter table public.ai_usage               enable row level security;
alter table public.ai_budgets             enable row level security;
alter table public.ai_model_configs       enable row level security;
alter table public.hackathon_requirement_maps enable row level security;
alter table public.requirement_evaluations enable row level security;
alter table public.project_reviews        enable row level security;
alter table public.project_review_findings enable row level security;
alter table public.defense_targets        enable row level security;

-- Shared predicates. A student owns a submission through their team.
create or replace function public.owns_submission(p_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.submissions sub
    join public.build_sessions s on s.id = sub.session_id
    where sub.id = p_submission_id
      and public.is_team_member(s.team_id)
  );
$$;

-- Student-read: their own submission's rows. No writes — Phase 5/6 writes
-- happen server-side with the service role.
drop policy if exists repositories_read on public.repositories;
create policy repositories_read on public.repositories
  for select
  using (public.is_admin() or public.owns_submission(submission_id));

drop policy if exists requirement_evaluations_read on public.requirement_evaluations;
create policy requirement_evaluations_read on public.requirement_evaluations
  for select
  using (public.is_admin() or public.owns_submission(submission_id));

drop policy if exists defense_targets_read on public.defense_targets;
create policy defense_targets_read on public.defense_targets
  for select
  using (public.is_admin() or public.owns_submission(submission_id));

-- The requirement map is part of the brief every signed-in participant reads.
drop policy if exists requirement_maps_read on public.hackathon_requirement_maps;
create policy requirement_maps_read on public.hackathon_requirement_maps
  for select
  using (public.is_admin() or exists (
    select 1 from public.hackathons h
    where h.id = hackathon_requirement_maps.hackathon_id
      and h.practice_enabled
  ));

-- Everything else is admin-only. No policy means no access at all for anon or
-- student keys, which is exactly what §90 requires.
drop policy if exists project_reviews_read on public.project_reviews;
create policy project_reviews_read on public.project_reviews
  for select
  using (public.is_admin() or public.owns_submission(submission_id));

drop policy if exists project_review_findings_read on public.project_review_findings;
create policy project_review_findings_read on public.project_review_findings
  for select
  using (public.is_admin() or exists (
    select 1 from public.project_reviews r
    where r.id = project_review_findings.project_review_id
      and public.owns_submission(r.submission_id)
  ));


-- ────────────────────────────────────────────────────────────────────────────
-- Budgets
-- ────────────────────────────────────────────────────────────────────────────
-- Defaults from §53. Created once; an admin edits them afterwards.
insert into public.ai_budgets (scope, max_cost_usd, max_input_tokens, max_output_tokens, max_requests)
select 'global', 25.000000, 5000000, 1000000, 5000
where not exists (select 1 from public.ai_budgets where scope = 'global');

-- The effective budget for one submission: the submission row if the admin set
-- one, otherwise the global default. The service asks this before every call.
create or replace function public.ai_budget_for_submission(p_submission_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when auth.role() = 'service_role' or public.is_admin() then coalesce(
      (
        select to_jsonb(b) - 'user_id' - 'submission_id' - 'id' - 'created_at' - 'updated_at'
        from public.ai_budgets b
        where b.scope = 'submission'
          and b.submission_id = p_submission_id
        limit 1
      ),
      (
        select to_jsonb(b) - 'user_id' - 'submission_id' - 'id' - 'created_at' - 'updated_at'
        from public.ai_budgets b
        where b.scope = 'global'
        limit 1
      )
    )
    else null
  end;
$$;

-- Atomic usage increment. Doing this in one statement avoids a read-modify-write
-- race between two concurrent AI calls on the same submission.
create or replace function public.ai_record_usage(
  p_operation     text,
  p_provider      text,
  p_model         text,
  p_prompt_version text,
  p_input_tokens  integer,
  p_output_tokens integer,
  p_cached_tokens integer,
  p_cost_usd      numeric,
  p_request_id    text,
  p_status        text,
  p_error_code    text,
  p_error_message text,
  p_duration_ms   integer,
  p_user_id       uuid,
  p_submission_id uuid,
  p_repository_id uuid,
  p_session_id    uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- SECURITY DEFINER, so it must gate itself: only the API (service role) and
  -- an admin may write to the accounting ledger. Without this check any
  -- signed-in student could call it and exhaust every budget.
  if auth.role() <> 'service_role' and not public.is_admin() then
    raise exception 'You are not authorized to perform this action.';
  end if;

  insert into public.ai_usage (
    operation, provider, model, prompt_version,
    input_tokens, output_tokens, total_tokens, cached_tokens, cache_miss_tokens,
    estimated_cost_usd, request_id, status, error_code, error_message, duration_ms,
    user_id, submission_id, repository_id, session_id
  )
  values (
    p_operation, p_provider, p_model, p_prompt_version,
    p_input_tokens, p_output_tokens,
    p_input_tokens + p_output_tokens,
    p_cached_tokens, greatest(0, p_input_tokens - p_cached_tokens),
    p_cost_usd, p_request_id, p_status, p_error_code,
    left(coalesce(p_error_message, ''), 500), p_duration_ms,
    p_user_id, p_submission_id, p_repository_id, p_session_id
  )
  returning id into v_id;

  -- Only spend counts against a budget. A rejected or failed call is free.
  if p_status = 'success' and p_submission_id is not null then
    update public.ai_budgets
       set used_cost_usd     = used_cost_usd + p_cost_usd,
           used_input_tokens = used_input_tokens + p_input_tokens,
           used_output_tokens = used_output_tokens + p_output_tokens,
           used_requests     = used_requests + 1
     where scope = 'submission' and submission_id = p_submission_id;

    if not found then
      insert into public.ai_budgets (scope, submission_id)
      values ('submission', p_submission_id);
    end if;
  end if;

  if p_status = 'success' then
    update public.ai_budgets
       set used_cost_usd     = used_cost_usd + p_cost_usd,
           used_input_tokens = used_input_tokens + p_input_tokens,
           used_output_tokens = used_output_tokens + p_output_tokens,
           used_requests     = used_requests + 1
     where scope = 'global';
  end if;

  return v_id;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Admin reporting
-- ────────────────────────────────────────────────────────────────────────────
-- §62, §64, §65, §66, §67 — every dashboard number in one round trip.
create or replace function public.admin_analysis_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users',              (select count(*) from public.profiles),
    'teams',              (select count(*) from public.teams),
    'hackathons',         (select count(*) from public.hackathons),
    'active_sessions',    (select count(*) from public.build_sessions
                            where status in ('running', 'break')),
    'completed_sessions', (select count(*) from public.build_sessions
                            where status = 'completed'),
    'expired_sessions',   (select count(*) from public.build_sessions
                            where status = 'expired'),
    'submitted_sessions', (select count(*) from public.build_sessions
                            where status = 'submitted'),
    'submissions_draft',  (select count(*) from public.submissions
                            where status = 'draft'),
    'submissions_final',  (select count(*) from public.submissions
                            where status = 'submitted'),
    'repositories',       (select count(*) from public.repositories),
    'analyzed',           (select count(*) from public.repositories
                            where analysis_status in ('completed', 'limited')),
    'analysis_failed',    (select count(*) from public.repositories
                            where analysis_status = 'failed'),
    'reviews',            (select count(*) from public.project_reviews
                            where status = 'completed'),
    'requirements_checked', (select count(*) from public.requirement_evaluations),
    'evidence_found',     (select count(*) from public.requirement_evaluations
                            where status = 'evidence_found'),
    'partial_evidence',   (select count(*) from public.requirement_evaluations
                            where status = 'partial_evidence'),
    'not_evidenced',      (select count(*) from public.requirement_evaluations
                            where status = 'not_evidenced'),
    'findings',           (select count(*) from public.project_review_findings),
    'defense_targets',    (select count(*) from public.defense_targets)
  )
  where public.is_admin();
$$;

-- §67, §69 — AI usage rollups. `p_since` is an ISO timestamp.
create or replace function public.ai_usage_summary(p_since timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'requests',       (select count(*) from public.ai_usage
                        where created_at >= p_since),
    'success',        (select count(*) from public.ai_usage
                        where created_at >= p_since and status = 'success'),
    'failed',         (select count(*) from public.ai_usage
                        where created_at >= p_since and status = 'failed'),
    'rejected',       (select count(*) from public.ai_usage
                        where created_at >= p_since and status = 'rejected'),
    'input_tokens',   (select coalesce(sum(input_tokens), 0) from public.ai_usage
                        where created_at >= p_since),
    'output_tokens',  (select coalesce(sum(output_tokens), 0) from public.ai_usage
                        where created_at >= p_since),
    'cached_tokens',  (select coalesce(sum(cached_tokens), 0) from public.ai_usage
                        where created_at >= p_since),
    'total_cost',     (select coalesce(sum(estimated_cost_usd), 0) from public.ai_usage
                        where created_at >= p_since),
    'error_codes',    (select coalesce(jsonb_object_agg(e.error_code, e.n), '{}'::jsonb)
                        from (
                          select error_code, count(*) as n
                          from public.ai_usage
                          where created_at >= p_since
                            and status in ('failed', 'rejected')
                            and error_code is not null
                          group by error_code
                        ) e)
  )
  where public.is_admin();
$$;

-- §78 — repositories table, admin view.
create or replace function public.admin_repositories()
returns table (
  id               uuid,
  submission_id    uuid,
  project_name     text,
  team_name        text,
  owner            text,
  repo_name        text,
  commit_sha       text,
  analysis_status  text,
  analysis_mode    text,
  file_count       integer,
  secret_count     integer,
  review_status    text,
  last_analyzed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.submission_id,
         nullif(sub.project_name, ''), t.name, r.owner, r.repo_name,
         r.analyzed_commit_sha, r.analysis_status, r.analysis_mode,
         r.file_count, r.secret_count,
         pr.status, r.last_analyzed_at
  from public.repositories r
  join public.submissions sub on sub.id = r.submission_id
  join public.teams t         on t.id = sub.team_id
  left join public.project_reviews pr on pr.repository_id = r.id
  where public.is_admin()
  order by r.updated_at desc;
$$;

-- §79 — project reviews, admin view.
create or replace function public.admin_project_reviews()
returns table (
  id                uuid,
  submission_id     uuid,
  project_name      text,
  team_name         text,
  status            text,
  requirements_done integer,
  findings          integer,
  cost_usd          numeric,
  total_tokens      integer,
  updated_at        timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select pr.id, pr.submission_id,
         nullif(sub.project_name, ''), t.name, pr.status,
         (select count(*) from public.requirement_evaluations re
           where re.submission_id = pr.submission_id),
         (select count(*) from public.project_review_findings f
           where f.project_review_id = pr.id),
         pr.estimated_cost_usd, pr.total_tokens, pr.updated_at
  from public.project_reviews pr
  join public.submissions sub on sub.id = pr.submission_id
  join public.teams t         on t.id = sub.team_id
  where public.is_admin()
  order by pr.updated_at desc;
$$;

-- §80, §84 — the full analysis payload for one submission. Admin sees
-- everything; a student sees the same shape minus the AI cost/token fields.
create or replace function public.submission_analysis(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_admin      boolean := public.is_admin();
  v_owns       boolean := public.owns_submission(p_submission_id);
  v_result     jsonb;
begin
  if not (v_admin or v_owns) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  select jsonb_build_object(
    'submission', to_jsonb(sub) - 'submitted_by',
    'hackathon',  to_jsonb(h),
    'team',       to_jsonb(t) - 'created_by',
    'repository', (
      select to_jsonb(r) - 'evidence' from public.repositories r
      where r.submission_id = p_submission_id
    ),
    'project_map', (
      select r.project_map from public.repositories r
      where r.submission_id = p_submission_id
    ),
    'evidence', (
      select r.evidence from public.repositories r
      where r.submission_id = p_submission_id
    ),
    'requirement_map', (
      select jsonb_build_object(
        'version',     m.version,
        'requirements',     m.requirements,
        'constraints',      m.constraints,
        'expected_outcomes', m.expected_outcomes,
        'evaluation_criteria', m.evaluation_criteria
      )
      from public.hackathon_requirement_maps m
      where m.hackathon_id = sub.hackathon_id
      order by m.version desc limit 1
    ),
    'requirements', (
      select coalesce(jsonb_agg(to_jsonb(re) order by re.requirement_id), '[]'::jsonb)
      from public.requirement_evaluations re
      where re.submission_id = p_submission_id
    ),
    'review', (
      select jsonb_build_object(
        'id', pr.id, 'status', pr.status, 'summary', pr.summary,
        'problem_alignment', pr.problem_alignment, 'requirements', pr.requirements,
        'constraints', pr.constraints, 'expected_outcomes', pr.expected_outcomes,
        'evaluation_criteria', pr.evaluation_criteria,
        'architecture', pr.architecture, 'implementation', pr.implementation,
        'security', pr.security, 'database_review', pr.database_review,
        'testing', pr.testing, 'scalability', pr.scalability,
        'technical_decisions', pr.technical_decisions, 'contributions', pr.contributions
      )
      from public.project_reviews pr
      where pr.submission_id = p_submission_id
      order by pr.updated_at desc limit 1
    ),
    'findings', (
      select coalesce(jsonb_agg(to_jsonb(f) order by
                 case f.severity
                   when 'critical' then 0 when 'high' then 1 when 'medium' then 2
                   when 'low' then 3 else 4 end), '[]'::jsonb)
      from public.project_review_findings f
      join public.project_reviews pr2 on pr2.id = f.project_review_id
      where pr2.submission_id = p_submission_id
    ),
    'defense_targets', (
      select coalesce(jsonb_agg(to_jsonb(d) order by d.priority), '[]'::jsonb)
      from public.defense_targets d
      where d.submission_id = p_submission_id
    ),
    'contributions', (
      select coalesce(jsonb_agg(to_jsonb(sm) order by sm.created_at), '[]'::jsonb)
      from public.submission_members sm
      where sm.submission_id = p_submission_id
    ),
    'ai_usage', case when v_admin then (
      select jsonb_build_object(
        'requests', count(*),
        'input_tokens',  coalesce(sum(input_tokens), 0),
        'output_tokens', coalesce(sum(output_tokens), 0),
        'cached_tokens', coalesce(sum(cached_tokens), 0),
        'cost_usd',      coalesce(sum(estimated_cost_usd), 0),
        'operations', coalesce((
          select jsonb_object_agg(agg.operation, agg.n)
          from (
            select operation, count(*) as n
            from public.ai_usage
            where submission_id = p_submission_id
            group by operation
          ) agg
        ), '{}'::jsonb)
      )
      from public.ai_usage where submission_id = p_submission_id
    ) else null end
  )
  into v_result
  from public.submissions sub
  join public.hackathons h on h.id = sub.hackathon_id
  join public.teams t       on t.id = sub.team_id
  where sub.id = p_submission_id;

  return v_result;
end;
$$;

-- §76 — cost forecast from real historical averages, clearly an estimate.
create or replace function public.ai_cost_forecast()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with per_submission as (
    select submission_id, sum(estimated_cost_usd) as cost, sum(total_tokens) as tokens
    from public.ai_usage
    where status = 'success' and submission_id is not null
    group by submission_id
  )
  select jsonb_build_object(
    'analyzed_submissions', (select count(*) from per_submission),
    'avg_cost_usd',         coalesce((select avg(cost) from per_submission), 0),
    'avg_tokens',           coalesce((select avg(tokens) from per_submission), 0),
    'projections', jsonb_build_array(
      jsonb_build_object('submissions', 10,
        'estimated_cost_usd', round(coalesce((select avg(cost) from per_submission), 0) * 10, 6)),
      jsonb_build_object('submissions', 50,
        'estimated_cost_usd', round(coalesce((select avg(cost) from per_submission), 0) * 50, 6)),
      jsonb_build_object('submissions', 100,
        'estimated_cost_usd', round(coalesce((select avg(cost) from per_submission), 0) * 100, 6)),
      jsonb_build_object('submissions', 500,
        'estimated_cost_usd', round(coalesce((select avg(cost) from per_submission), 0) * 500, 6))
    )
  )
  where public.is_admin();
$$;
