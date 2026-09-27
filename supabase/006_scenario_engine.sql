-- ────────────────────────────────────────────────────────────────────────────
-- 006_scenario_engine.sql
--
-- The foundation the future Presentation / Question / Follow-up / Defense /
-- Voice Defense / Final Report / Replay phases will read. None of those are
-- built here; what is built is the durable, versioned, evidence-backed record
-- they will consume without a schema redesign.
--
-- Design rules that apply throughout:
--
--   • Facts, claims and interpretations are stored in separate columns and
--     separate tables. A student claim is never overwritten by an AI reading
--     of the repository — the two are different claims about different things,
--     and collapsing them loses the only thing worth arguing about later.
--
--   • Nothing here is a single JSON blob. Knowledge is structured so a future
--     phase can query one field without parsing prose.
--
--   • Deletion is dependency-aware and audited. `deleted_at` is set rather than
--     rows removed, because §37 is right: deletion is not a retention strategy.
--
--   • Wildcard content is stored here and read only through SECURITY DEFINER
--     functions, so it never reaches a client that has not started a session.
--
-- Idempotent: safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
-- 1. Hackathon format & scenario engine (Part 1, 2)
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hackathons
  add column if not exists hackathon_type text not null default 'problem_statement'
    check (hackathon_type in ('problem_statement', 'open_innovation', 'theme_based',
                              'industry_scenario', 'government_public_problem',
                              'technology_challenge', 'wildcard', 'custom')),
  add column if not exists theme text,
  add column if not exists domain text,
  add column if not exists scenario text,
  add column if not exists context text,
  add column if not exists target_users text,
  add column if not exists problem_discovery_required boolean not null default false,
  add column if not exists ai_assistance_allowed boolean not null default true,
  add column if not exists difficulty text not null default 'intermediate'
    check (difficulty in ('beginner', 'intermediate', 'advanced', 'expert')),
  add column if not exists hints text,
  -- §1.1 asks for expected_outcomes; the pre-existing singular column is kept
  -- so existing rows and RPCs keep working. Both feed the requirement map.
  add column if not exists expected_outcomes text,

  -- Part 20 — the post-build GitHub window is per-hackathon configuration,
  -- never a hardcoded constant. The UI may offer common values, but any
  -- duration between 1 and 240 minutes is valid.
  add column if not exists github_submission_window_enabled boolean not null default false,
  add column if not exists github_submission_window_minutes integer not null default 5
    check (github_submission_window_minutes between 1 and 240);

comment on column public.hackathons.hackathon_type is
  'Selects the participant experience. Never branch on this in the client alone; the required-field list is resolved by required_fields_for_type().';

-- One scenario library per hackathon, so a hackathon can offer several angles
-- and a session can be assigned one. `is_wildcard` rows are the only content a
-- wildcard simulation reveals, and only after the build timer ends.
create table if not exists public.hackathon_scenarios (
  id            uuid primary key default gen_random_uuid(),
  hackathon_id  uuid        not null references public.hackathons (id) on delete cascade,

  title         text        not null check (length(trim(title)) between 1 and 200),
  scenario_text text        not null,
  context       text,
  theme         text,
  domain        text,
  target_users  text,
  constraints   text,
  hints         text,
  difficulty    text        not null default 'intermediate'
                  check (difficulty in ('beginner', 'intermediate', 'advanced', 'expert')),

  -- A wildcard scenario is a sealed envelope. It carries no plaintext field, so
  -- there is nothing for a stray `select *` to leak.
  is_wildcard   boolean     not null default false,
  revealed_at   timestamptz,
  assigned_to   uuid        references public.build_sessions (id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists hackathon_scenarios_hackathon_idx
  on public.hackathon_scenarios (hackathon_id);

-- Sealed wildcard payload. Separate table, RLS enabled, zero read policies, and
-- only reachable through reveal_wildcard_scenario() — a SECURITY DEFINER
-- function that refuses unless the caller is on an expired build session.
create table if not exists public.hackathon_wildcards (
  scenario_id     uuid primary key references public.hackathon_scenarios (id) on delete cascade,
  payload         text        not null,
  reveal_hint     text,
  created_at      timestamptz not null default now()
);

-- Open Innovation: the student supplies the problem, so it is captured as a
-- first-class record rather than inferred from a submission blob later.
create table if not exists public.problem_discoveries (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid        not null references public.build_sessions (id) on delete cascade,
  team_id           uuid        not null references public.teams (id) on delete cascade,

  problem_statement   text      not null default '',
  why_it_matters      text      not null default '',
  target_users        text      not null default '',
  pain_point          text      not null default '',
  proposed_solution   text      not null default '',
  expected_outcome    text      not null default '',

  status            text        not null default 'draft'
                      check (status in ('draft', 'submitted', 'locked')),
  submitted_at      timestamptz,
  -- Set when the status reaches 'locked'. The build timer is authoritative, so
  -- the database decides when locking is allowed, not the client.
  locked_at         timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One working draft per session, but a session may revise until it locks. The
-- partial unique index is what stops two concurrent tabs creating two drafts.
create unique index if not exists problem_discoveries_one_draft
  on public.problem_discoveries (session_id)
  where status = 'draft';

create unique index if not exists problem_discoveries_one_locked
  on public.problem_discoveries (session_id)
  where status = 'locked';


-- ════════════════════════════════════════════════════════════════════════════
-- 2. Configurable post-build GitHub submission window (Part 20)
-- ════════════════════════════════════════════════════════════════════════════

alter table public.build_sessions
  add column if not exists build_ends_at timestamptz,
  add column if not exists github_submission_started_at timestamptz,
  add column if not exists github_submission_ends_at timestamptz,

  -- Part 23 — the window configuration is snapshotted when the simulation
  -- starts. If the admin later changes the hackathon's window, running
  -- simulations keep the deadline they started with; only new simulations
  -- pick up the new value. Without the snapshot, editing the hackathon would
  -- silently move an active team's deadline.
  add column if not exists github_submission_window_enabled boolean not null default false,
  add column if not exists github_submission_window_minutes integer not null default 5
    check (github_submission_window_minutes between 1 and 240);

-- `ends_at` is the build deadline and is never null; build_ends_at mirrors it
-- so the two concepts are separately readable. Backfilled rather than left null
-- so no caller has to handle a half-populated row.
update public.build_sessions
   set build_ends_at = ends_at
 where build_ends_at is null;

alter table public.build_sessions
  alter column build_ends_at set not null;

-- The window is a distinct phase with its own status, so "the build is over but
-- you may still submit" is representable without a boolean soup.
alter table public.build_sessions
  drop constraint if exists build_sessions_status_check;

alter table public.build_sessions
  add constraint build_sessions_status_check
  check (status in ('not_started', 'running', 'break', 'completed', 'expired',
                    'build_expired', 'github_submission', 'submitted',
                    'github_submission_expired', 'cancelled'));

-- Part 23 — the snapshot at start. `start_build_session` (002) reads the
-- hackathon's window configuration into these columns when it inserts the
-- session; the SELECT below rewrites the function for anyone applying 002
-- before 006, which is the supported order. Existing sessions keep whatever
-- they were started with, and later admin edits to the hackathon never move
-- an active simulation's deadline.
create or replace function public.start_build_session(p_hackathon_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id  uuid;
  v_duration integer;
  v_enabled  boolean;
  v_status   text;
  v_existing uuid;
  v_new      uuid;
  v_window_enabled boolean;
  v_window_minutes integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to start a simulation.';
  end if;

  select tm.team_id into v_team_id
  from public.team_members tm
  where tm.user_id = auth.uid()
  limit 1;

  if v_team_id is null then
    raise exception 'Create or join a team before starting a simulation.';
  end if;

  select simulation_duration_minutes, practice_enabled, status,
         github_submission_window_enabled, github_submission_window_minutes
    into v_duration, v_enabled, v_status, v_window_enabled, v_window_minutes
  from public.hackathons
  where id = p_hackathon_id;

  if v_duration is null then
    raise exception 'That hackathon does not exist.';
  end if;

  if not v_enabled then
    raise exception 'No active practice hackathon.';
  end if;

  if v_status <> 'active' then
    raise exception 'That hackathon is not open for participation.';
  end if;

  select id into v_existing
  from public.build_sessions
  where team_id = v_team_id
    and status in ('running', 'break')
  limit 1;

  if v_existing is not null then
    raise exception 'Your team already has a simulation in progress.';
  end if;

  insert into public.build_sessions
    (hackathon_id, team_id, started_by, started_at, ends_at, status,
     github_submission_window_enabled, github_submission_window_minutes)
  values
    (p_hackathon_id, v_team_id, auth.uid(), now(),
     now() + make_interval(mins => v_duration), 'running',
     coalesce(v_window_enabled, false), coalesce(v_window_minutes, 5))
  returning id into v_new;

  return v_new;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. Versioned project knowledge (Part 3, 29)
-- ════════════════════════════════════════════════════════════════════════════

-- One row per commit analysed. v1→abc123, v2→def456. Never overwritten: §30
-- says a future Presentation must not rescan, which it cannot do if the previous
-- version is gone.
create table if not exists public.project_knowledge (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid        not null references public.submissions (id) on delete cascade,
  hackathon_id      uuid        not null references public.hackathons (id) on delete restrict,
  team_id           uuid        not null references public.teams (id) on delete cascade,
  version           integer     not null check (version >= 1),

  -- Provenance first: this is what makes the row auditable rather than a claim.
  commit_sha        text        not null,
  scanner_version   text,
  analysis_version  text,
  prompt_versions   jsonb       not null default '{}'::jsonb,
  repository_id     uuid        references public.repositories (id) on delete set null,
  analysis_id       uuid        references public.ai_analyses (id) on delete set null,

  -- What the hackathon asked, and what the team said they were solving.
  -- Deliberately separate from everything below: a claim is not a fact.
  project_summary       text,
  problem_statement     text,
  scenario_context      text,
  identified_problem    text,
  target_users          text,
  pain_points           jsonb     not null default '[]'::jsonb,
  solution_summary      text,

  -- What the repository actually contains, from the deterministic scanner.
  key_features          jsonb     not null default '[]'::jsonb,
  tech_stack            jsonb     not null default '[]'::jsonb,
  architecture_summary  text,
  frontend_summary      text,
  backend_summary       text,
  database_summary      text,
  authentication_summary text,
  api_summary           text,
  deployment_summary    text,
  testing_summary       text,
  security_summary      text,

  constraints           jsonb     not null default '[]'::jsonb,
  expected_outcomes     jsonb     not null default '[]'::jsonb,
  evaluation_criteria   jsonb     not null default '[]'::jsonb,

  -- Evidence graph anchors. IDs only, never copied prose (§39: the connection
  -- CLAIM → EVIDENCE → FILE → SYMBOL → COMMIT → MEMBER must survive).
  important_files        jsonb   not null default '[]'::jsonb,
  important_symbols      jsonb   not null default '[]'::jsonb,
  important_evidence_ids text[]  not null default '{}',

  technical_decisions jsonb      not null default '[]'::jsonb,
  tradeoffs           jsonb      not null default '[]'::jsonb,
  known_limitations   jsonb      not null default '[]'::jsonb,

  potential_issues jsonb         not null default '[]'::jsonb,
  confirmed_issues jsonb         not null default '[]'::jsonb,

  -- Student claims and their verdicts, kept apart from the knowledge above.
  claim_verification jsonb       not null default '{}'::jsonb,
  team_summary       text,
  ai_usage_summary   jsonb       not null default '{}'::jsonb,

  is_current          boolean     not null default true,
  deleted_at          timestamptz,
  deleted_by          uuid        references public.profiles (id) on delete set null,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (submission_id, version)
);

-- Exactly one current version per submission. A partial unique index is the
-- only way to say this in Postgres without a trigger.
create unique index if not exists project_knowledge_one_current
  on public.project_knowledge (submission_id)
  where is_current and deleted_at is null;

create index if not exists project_knowledge_submission_idx
  on public.project_knowledge (submission_id, version desc);

-- Per-member knowledge. A team's average is not a person's contribution, and a
-- future Defense phase needs to address the person, not the team.
create table if not exists public.member_project_knowledge (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid        not null references public.submissions (id) on delete cascade,
  user_id           uuid        not null references public.profiles (id) on delete cascade,
  version           integer     not null default 1,
  commit_sha        text,

  -- What the member said.
  contribution_description   text not null default '',
  planned_responsibilities  text,

  -- What the evidence says about that claim. §10: never `false` — the honest
  -- verdict for absent evidence is `not_yet_verified`.
  verified_contributions              jsonb not null default '[]'::jsonb,
  partially_verified_contributions    jsonb not null default '[]'::jsonb,
  unverified_claims                   jsonb not null default '[]'::jsonb,

  important_files        jsonb  not null default '[]'::jsonb,
  important_symbols      jsonb  not null default '[]'::jsonb,
  important_evidence_ids text[] not null default '{}',

  technical_decisions              jsonb not null default '[]'::jsonb,
  known_areas_of_understanding     jsonb not null default '[]'::jsonb,
  areas_requiring_clarification    jsonb not null default '[]'::jsonb,

  deleted_at timestamptz,
  deleted_by uuid        references public.profiles (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (submission_id, user_id, version)
);

create index if not exists member_project_knowledge_lookup_idx
  on public.member_project_knowledge (submission_id, user_id);


-- ════════════════════════════════════════════════════════════════════════════
-- 4. Question targets (Part 12)
-- ════════════════════════════════════════════════════════════════════════════

-- The target of a future question. Not a question: generating the actual
-- question text is the Defense phase's job, and it should not be able to do so
-- from a record that was built without evidence in mind.
create table if not exists public.question_targets (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid        not null references public.submissions (id) on delete cascade,
  user_id           uuid        references public.profiles (id) on delete cascade,

  topic             text        not null,
  -- Where this came from: 'contribution', 'architecture', 'claim', 'issue', …
  source_type       text        not null default 'contribution'
                      check (source_type in ('contribution', 'architecture', 'implementation',
                                             'technical_decision', 'security', 'testing',
                                             'claim', 'issue', 'scalability')),
  -- REQ-001, EV-021, FEATURE-003… Stable IDs, so a target can always be traced
  -- back to the thing that provoked it.
  source_ids        text[]      not null default '{}',
  reason            text,

  priority          text        not null default 'P3'
                      check (priority in ('P0','P1','P2','P3','P4','P5')),
  difficulty        text        not null default 'medium'
                      check (difficulty in ('easy', 'medium', 'hard')),
  question_area     text,
  follow_up_possible boolean    not null default true,

  created_at        timestamptz not null default now()
);

create index if not exists question_targets_submission_idx
  on public.question_targets (submission_id, priority);


-- ════════════════════════════════════════════════════════════════════════════
-- 5. Soft delete + audit log (Part 15, 16, 17)
-- ════════════════════════════════════════════════════════════════════════════

-- Only entities where deletion would destroy something a later phase needs.
-- Deliberately not added everywhere: a table with no history to protect should
-- be able to vanish.
alter table public.hackathons            add column if not exists deleted_at timestamptz;
alter table public.hackathons            add column if not exists deleted_by uuid references public.profiles (id) on delete set null;
alter table public.build_sessions       add column if not exists deleted_at timestamptz;
alter table public.build_sessions       add column if not exists deleted_by uuid references public.profiles (id) on delete set null;
alter table public.submissions          add column if not exists deleted_at timestamptz;
alter table public.submissions          add column if not exists deleted_by uuid references public.profiles (id) on delete set null;
alter table public.repositories         add column if not exists deleted_at timestamptz;
alter table public.repositories         add column if not exists deleted_by uuid references public.profiles (id) on delete set null;
alter table public.project_reviews      add column if not exists deleted_at timestamptz;
alter table public.project_reviews      add column if not exists deleted_by uuid references public.profiles (id) on delete set null;
alter table public.teams                 add column if not exists deleted_at timestamptz;
alter table public.teams                 add column if not exists deleted_by uuid references public.profiles (id) on delete set null;

-- Part 15.12. Written on every destructive or archiving action, and read by
-- nobody but an admin. `metadata` is jsonb so the shape can grow, and §15.12
-- forbids putting a secret in it — the writer redacts before it gets here.
create table if not exists public.admin_audit_logs (
  id             uuid primary key default gen_random_uuid(),
  admin_user_id  uuid        references public.profiles (id) on delete set null,
  action         text        not null
                   check (action in ('created', 'updated', 'archived', 'restored',
                                     'deleted', 'permanently_deleted', 'enabled', 'disabled')),
  entity_type    text        not null,
  entity_id      uuid,
  entity_name    text,
  reason         text,
  metadata       jsonb       not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists admin_audit_logs_recent_idx
  on public.admin_audit_logs (created_at desc);

create index if not exists admin_audit_logs_entity_idx
  on public.admin_audit_logs (entity_type, entity_id);


-- ════════════════════════════════════════════════════════════════════════════
-- 6. Claim verification ledger (Part 10)
-- ════════════════════════════════════════════════════════════════════════════

-- The student's own words, stored before any analysis runs. This is the column
-- an AI reading is allowed to argue with, and the reason a claim_mismatch
-- finding is meaningful rather than circular.
create table if not exists public.submission_claims (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid        not null references public.submissions (id) on delete cascade,
  user_id           uuid        references public.profiles (id) on delete set null,

  -- FEATURE-001, CLAIM-001 — the student may name it, or we assign a stable one.
  claim_ref         text        not null,
  claim_text        text        not null,
  claim_type        text        not null default 'feature'
                      check (claim_type in ('feature', 'architecture', 'integration',
                                            'data_model', 'testing', 'security',
                                            'performance', 'other')),

  -- §10 in full. `false` is deliberately not an option: absent evidence is not
  -- disproof, and a schema that can express it will eventually say it.
  status            text        not null default 'not_yet_verified'
                      check (status in ('supported', 'partially_supported',
                                        'not_yet_verified')),
  evidence_ids      text[]      not null default '{}',
  explanation       text,
  verified_by       text        not null default 'deterministic'
                      check (verified_by in ('deterministic', 'ai', 'manual', 'skipped')),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (submission_id, claim_ref)
);

create index if not exists submission_claims_submission_idx
  on public.submission_claims (submission_id);


-- ════════════════════════════════════════════════════════════════════════════
-- 7. Row Level Security for the new tables
-- ════════════════════════════════════════════════════════════════════════════

alter table public.hackathon_scenarios     enable row level security;
alter table public.hackathon_wildcards     enable row level security;
alter table public.problem_discoveries     enable row level security;
alter table public.project_knowledge       enable row level security;
alter table public.member_project_knowledge enable row level security;
alter table public.question_targets        enable row level security;
alter table public.submission_claims       enable row level security;
alter table public.admin_audit_logs        enable row level security;

-- admin_audit_logs and hackathon_wildcards intentionally get NO policy. RLS
-- enabled with no policy means no client key can read them, ever; both are
-- reachable only through SECURITY DEFINER functions that check the caller.

-- A student may read a scenario for a hackathon they are running, and only if it
-- is not a sealed wildcard. The wildcard exclusion is duplicated here
-- deliberately: a policy that merely forgot the filter would leak the brief.
drop policy if exists scenarios_read on public.hackathon_scenarios;
create policy scenarios_read on public.hackathon_scenarios
  for select
  using (
    is_wildcard = false
    and (
      public.is_admin()
      or exists (
        select 1 from public.build_sessions bs
        join public.teams t on t.id = bs.team_id
        where bs.hackathon_id = hackathon_scenarios.hackathon_id
          and public.is_team_member(bs.team_id)
      )
    )
  );

-- A wildcard scenario's title is visible (so the card renders) but its text is
-- empty until reveal, because the text lives in the sealed table.
drop policy if exists scenarios_admin_write on public.hackathon_scenarios;
create policy scenarios_admin_write on public.hackathon_scenarios
  for all
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists discoveries_team_access on public.problem_discoveries;
create policy discoveries_team_access on public.problem_discoveries
  for select
  using (public.is_admin() or public.is_team_member(team_id));

drop policy if exists discoveries_admin_write on public.problem_discoveries;
create policy discoveries_admin_write on public.problem_discoveries
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- A member sees only their own knowledge row; a teammate's is the Defense
-- phase's business, not a student's.
drop policy if exists project_knowledge_read on public.project_knowledge;
create policy project_knowledge_read on public.project_knowledge
  for select
  using (
    public.is_admin()
    or public.owns_submission(submission_id)
  );

drop policy if exists member_knowledge_self_read on public.member_project_knowledge;
create policy member_knowledge_self_read on public.member_project_knowledge
  for select
  using (public.is_admin() or auth.uid() = user_id);

drop policy if exists question_targets_read on public.question_targets;
create policy question_targets_read on public.question_targets
  for select
  using (
    public.is_admin()
    or public.owns_submission(submission_id)
  );

drop policy if exists submission_claims_read on public.submission_claims;
create policy submission_claims_read on public.submission_claims
  for select
  using (public.is_admin() or public.owns_submission(submission_id));

-- Writes to the knowledge and target tables are server-side only. A student
-- cannot rewrite the record of what was found about their project.
