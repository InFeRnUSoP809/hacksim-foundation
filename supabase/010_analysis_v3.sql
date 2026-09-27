-- ═══════════════════════════════════════════════════════════════════════════
-- 010 · Phase 5 + 6 rebuild
--
-- Everything here exists because the analysis stopped asking "which
-- technologies are present" and started asking "what does this repository
-- implement, and does that match the brief".
--
-- Three things change:
--
--   1. A hackathon becomes a first-class, typed, versioned object. Its problem
--      statement is optional, because an open-innovation brief legitimately has
--      none, and the type changes what the analysis even looks at.
--   2. A conclusion carries its provenance: which method produced it, which
--      queries retrieved it, which files were considered, whether a model was
--      used and why. That is what makes the result explainable instead of
--      merely asserted.
--   3. Every run leaves a snapshot, so a later brief change or a new commit
--      produces a *diff* instead of silently rewriting the past.
--
-- Idempotent: safe to run more than once.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. The hackathon becomes typed and versioned ───────────────────────────

alter table public.hackathons
  alter column problem_statement drop not null;

alter table public.hackathons
  add column if not exists hackathon_type text,
  add column if not exists theme text,
  add column if not exists custom_instructions text,
  add column if not exists technology_restrictions text,
  add column if not exists dataset_requirements text,
  add column if not exists deployment_requirements text,
  add column if not exists config_version integer not null default 1;

-- The type list is intentionally NOT a check constraint. A hackathon may be
-- "fintech_regulatory_sandbox" and the engine carries the label through
-- untouched; refusing to store it would not make the engine more correct.
update public.hackathons
   set hackathon_type = 'open_innovation'
 where hackathon_type is null
   and coalesce(trim(problem_statement), '') = ''
   and coalesce(trim(requirements), '') = '';

update public.hackathons
   set hackathon_type = 'problem_statement'
 where hackathon_type is null;

-- Bump the configuration version whenever the brief actually changes, so an
-- old analysis can be told apart from a new one.
create or replace function public.bump_hackathon_config_version()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.problem_statement     is distinct from old.problem_statement
     or new.requirements        is distinct from old.requirements
     or new.constraints         is distinct from old.constraints
     or new.expected_outcome    is distinct from old.expected_outcome
     or new.evaluation_criteria is distinct from old.evaluation_criteria
     or new.theme               is distinct from old.theme
     or new.hackathon_type      is distinct from old.hackathon_type
     or new.custom_instructions is distinct from old.custom_instructions
     or new.technology_restrictions is distinct from old.technology_restrictions
     or new.dataset_requirements    is distinct from old.dataset_requirements
     or new.deployment_requirements is distinct from old.deployment_requirements
  then
    new.config_version := old.config_version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists hackathons_config_version on public.hackathons;
create trigger hackathons_config_version
  before update on public.hackathons
  for each row execute function public.bump_hackathon_config_version();

-- ── 2. A conclusion records how it was reached ────────────────────────────

alter table public.requirement_evaluations
  add column if not exists kind text not null default 'requirement',
  add column if not exists method text not null default 'ai_evidence',
  add column if not exists missing_or_unclear text[] not null default '{}',
  add column if not exists retrieval_queries text[] not null default '{}',
  add column if not exists relevant_files text[] not null default '{}',
  add column if not exists evidence_count integer not null default 0,
  add column if not exists ai_used boolean not null default true,
  add column if not exists ai_reason text;

create index if not exists requirement_evaluations_kind_idx
  on public.requirement_evaluations (submission_id, kind);

-- A conclusion may only claim a positive status with evidence behind it. This
-- is the same rule the edge function enforces, stated where a reviewer can see
-- it.
alter table public.requirement_evaluations
  drop constraint if exists requirement_evaluations_positive_needs_evidence;
alter table public.requirement_evaluations
  add constraint requirement_evaluations_positive_needs_evidence
  check (
    status in ('not_evidenced', 'unable_to_determine')
    or jsonb_array_length(to_jsonb(evidence_ids)) > 0
  ) not valid;

-- ── 3. The review keeps the new knowledge ──────────────────────────────────

alter table public.project_reviews
  add column if not exists analysis_version text,
  add column if not exists hackathon_version text,
  add column if not exists scanner_version text,
  add column if not exists commit_sha text,
  add column if not exists dimensions jsonb,
  add column if not exists requirement_rows jsonb,
  add column if not exists constraint_rows jsonb,
  add column if not exists outcome_rows jsonb,
  add column if not exists criterion_rows jsonb,
  add column if not exists assessment jsonb,
  add column if not exists engineering jsonb,
  add column if not exists diff jsonb,
  add column if not exists diagnostics_summary jsonb;

alter table public.project_review_findings
  add column if not exists expectation_source text not null default 'general';

-- Individual contribution analysis is gone. The column stays so the table is
-- not rewritten, but nothing writes to it and nothing reads it.
comment on column public.project_reviews.contributions is
  'Deprecated: individual contribution analysis was removed from Phase 6.';

-- ── 4. One snapshot per run (§27, §44, §45) ───────────────────────────────

create table if not exists public.analysis_snapshots (
  id                  uuid primary key default gen_random_uuid(),
  submission_id       uuid not null references public.submissions (id) on delete cascade,
  repository_id       uuid references public.repositories (id) on delete cascade,
  commit_sha          text,
  hackathon_version   text,
  analysis_version    text,
  scanner_version     text,
  prompt_versions     jsonb,
  plan                jsonb,
  hackathon_snapshot  jsonb,
  conclusions         jsonb,
  -- The evidence those conclusions cite, so a re-analysis can say which
  -- evidence appeared or disappeared without re-reading the old run.
  evidence_index      jsonb,
  evidence_count      integer not null default 0,
  input_tokens        integer not null default 0,
  output_tokens       integer not null default 0,
  cached_tokens       integer not null default 0,
  estimated_cost_usd  numeric(14, 8) not null default 0,
  created_at          timestamptz not null default now()
);

create index if not exists analysis_snapshots_submission_idx
  on public.analysis_snapshots (submission_id, created_at desc);
create index if not exists analysis_snapshots_repository_idx
  on public.analysis_snapshots (repository_id, created_at desc);

-- ── 5. The read payload carries the new shape ─────────────────────────────

create or replace function public.submission_analysis(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_admin  boolean := public.is_admin();
  v_owns   boolean := public.owns_submission(p_submission_id);
  v_result jsonb;
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
        'problem_alignment', pr.problem_alignment,
        'requirements', pr.requirements,
        'constraints', pr.constraints,
        'expected_outcomes', pr.expected_outcomes,
        'evaluation_criteria', pr.evaluation_criteria,
        'architecture', pr.architecture, 'implementation', pr.implementation,
        'security', pr.security, 'database_review', pr.database_review,
        'testing', pr.testing, 'scalability', pr.scalability,
        'technical_decisions', pr.technical_decisions,
        -- New, versioned knowledge.
        'analysis_version',  pr.analysis_version,
        'hackathon_version', pr.hackathon_version,
        'scanner_version',   pr.scanner_version,
        'commit_sha',        pr.commit_sha,
        'dimensions',        pr.dimensions,
        'requirement_rows',  pr.requirement_rows,
        'constraint_rows',   pr.constraint_rows,
        'outcome_rows',      pr.outcome_rows,
        'criterion_rows',    pr.criterion_rows,
        'assessment',        pr.assessment,
        'engineering',       pr.engineering,
        'diff',              pr.diff,
        'diagnostics_summary', pr.diagnostics_summary
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
    'analysis_runs', case when v_admin then (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id,
               'commit_sha', s.commit_sha,
               'created_at', s.created_at,
               'analysis_version', s.analysis_version,
               'hackathon_version', s.hackathon_version,
               'evidence_count', s.evidence_count,
               'input_tokens', s.input_tokens,
               'output_tokens', s.output_tokens,
               'cached_tokens', s.cached_tokens,
               'estimated_cost_usd', s.estimated_cost_usd
             ) order by s.created_at desc), '[]'::jsonb)
      from (
        select * from public.analysis_snapshots
        where submission_id = p_submission_id
        order by created_at desc limit 10
      ) s
    ) else null end,
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

-- ── 6. Admin: the same counts, plus the new provenance ─────────────────────

create or replace function public.admin_analysis_diagnostics(p_submission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_admin boolean := public.is_admin();
begin
  if not v_admin then
    raise exception 'You are not authorized to perform this action.';
  end if;

  return jsonb_build_object(
    'repository', (
      select jsonb_build_object(
        'files',           (select count(*) from public.repository_files f
                             join public.repositories r on r.id = f.repository_id
                             where r.submission_id = p_submission_id),
        'files_ignored',   (select count(*) from public.repository_files f
                             join public.repositories r on r.id = f.repository_id
                             where r.submission_id = p_submission_id and f.is_ignored),
        'evidence',        (select jsonb_array_length(coalesce(r.evidence, '[]'::jsonb))
                             from public.repositories r
                             where r.submission_id = p_submission_id),
        'analysis_mode',   (select r.analysis_mode from public.repositories r
                             where r.submission_id = p_submission_id),
        'commit_sha',      (select r.analyzed_commit_sha from public.repositories r
                             where r.submission_id = p_submission_id)
      )
      from public.repositories r where r.submission_id = p_submission_id
    ),
    'ai', (
      select jsonb_build_object(
        'requests',      count(*),
        'input_tokens',  coalesce(sum(input_tokens), 0),
        'output_tokens', coalesce(sum(output_tokens), 0),
        'cached_tokens', coalesce(sum(cached_tokens), 0),
        'cost_usd',      coalesce(sum(estimated_cost_usd), 0),
        'failed',        count(*) filter (where status = 'failed'),
        'rejected',      count(*) filter (where status = 'rejected')
      )
      from public.ai_usage where submission_id = p_submission_id
    ),
    'conclusions', (
      select coalesce(jsonb_agg(to_jsonb(e) order by e.requirement_id), '[]'::jsonb)
      from public.requirement_evaluations e
      where e.submission_id = p_submission_id
    ),
    'runs', (
      select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at desc), '[]'::jsonb)
      from (
        select * from public.analysis_snapshots
        where submission_id = p_submission_id
        order by created_at desc limit 5
      ) s
    )
  );
end;
$$;
