-- ────────────────────────────────────────────────────────────────────────────
-- 007_scenario_engine_rpcs.sql
--
-- The enforcement half of 006. Every rule in the spec that says "the backend
-- must decide" is a function here rather than a check in the client:
--
--   • the build timer and the five-minute window (§13.3)
--   • wildcard secrecy (§1.4)
--   • which fields a format requires (§1.4)
--   • locking a submission and its dependent records (§13.5)
--   • dependency-aware, audited deletion (§15, §17, §18)
--
-- These are SECURITY DEFINER on purpose: the caller is a student holding a
-- client key, and the decision needs the service role's view of the row. Each
-- one re-derives the caller's identity from `auth.uid()` and checks membership
-- itself — §27 says never trust what the frontend sends.
--
-- Idempotent: safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
-- 1. The build timer (§13.1, 13.3)
-- ════════════════════════════════════════════════════════════════════════════

-- The single source of truth for where a session is in time.
--
-- `now()` is the database clock, so a browser clock, a JavaScript timer or a
-- tampered localStorage cannot move it, and a page refresh calls this again
-- rather than resetting anything. The window is derived, never stored on trust:
--
--   github_submission_started_at = build_ends_at
--   github_submission_ends_at    = build_ends_at + 5 minutes
create or replace function public.session_clock(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'session_id',           s.id,
    'status',               s.status,
    'started_at',           s.started_at,
    'build_ends_at',        s.build_ends_at,
    'github_submission_started_at',
      greatest(s.build_ends_at, s.github_submission_started_at),
    'github_submission_ends_at',
      coalesce(s.github_submission_ends_at, s.build_ends_at + interval '5 minutes'),

    -- Seconds are computed, never decremented by the client.
    'build_seconds_remaining',
      greatest(0, floor(extract(epoch from (s.build_ends_at - now()))))::bigint,
    'github_window_seconds_remaining',
      greatest(0, floor(extract(epoch from (
        coalesce(s.github_submission_ends_at, s.build_ends_at + interval '5 minutes')
        - now()))))::bigint,

    'build_elapsed',
      s.build_ends_at <= now(),
    'github_window_open',
      s.build_ends_at <= now()
      and now() < coalesce(s.github_submission_ends_at,
                           s.build_ends_at + interval '5 minutes'),
    'can_edit_build',
      s.status = 'running' and s.build_ends_at > now()
  )
  from public.build_sessions s
  where s.id = p_session_id;
$$;

-- Moves a session into the submission window the moment the build expires.
-- Idempotent, and safe to call from a poller, a page load, or the analysis
-- kick-off — whoever arrives first wins, and the others see it already done.
create or replace function public.sync_session_phase(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status    text;
  v_build_end timestamptz;
  v_submitted timestamptz;
begin
  select status, build_ends_at, submitted_at
    into v_status, v_build_end, v_submitted
    from public.build_sessions
   where id = p_session_id
   for update;                      -- serialises two callers racing here

  if v_status is null then
    raise exception 'Simulation not found.';
  end if;

  if v_status in ('submitted', 'cancelled', 'github_submission_expired') then
    return v_status;                -- terminal: nothing to advance
  end if;

  if v_build_end > now() then
    return v_status;                -- still building
  end if;

  -- Past the deadline. If they submitted in time, the window is already closed
  -- by the submission; otherwise it is open and then it expires.
  if v_submitted is not null then
    update public.build_sessions set status = 'submitted', updated_at = now()
     where id = p_session_id;
    return 'submitted';
  end if;

  if now() >= v_build_end + interval '5 minutes' then
    update public.build_sessions
       set status = 'github_submission_expired',
           github_submission_started_at = coalesce(github_submission_started_at, v_build_end),
           github_submission_ends_at   = coalesce(github_submission_ends_at,
                                                  v_build_end + interval '5 minutes'),
           updated_at = now()
     where id = p_session_id;
    return 'github_submission_expired';
  end if;

  update public.build_sessions
     set status = 'build_expired',
         -- §13.3: the window starts at build end, computed once and stored, so
         -- a refresh cannot restart it.
         github_submission_started_at = coalesce(github_submission_started_at, v_build_end),
         github_submission_ends_at   = coalesce(github_submission_ends_at,
                                                v_build_end + interval '5 minutes'),
         updated_at = now()
   where id = p_session_id;
  return 'build_expired';
end;
$$;

-- Opens the window explicitly, for a client that wants the phase rather than
-- only a poll. Returns the resulting phase.
create or replace function public.open_github_window(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_team_member(
       (select team_id from public.build_sessions where id = p_session_id)
     ) and not public.is_admin() then
    raise exception 'Not your simulation.' using errcode = '42501';
  end if;

  perform public.sync_session_phase(p_session_id);

  -- Only promote to the submission phase if the window is genuinely open.
  update public.build_sessions
     set status = 'github_submission'
   where id = p_session_id
     and status = 'build_expired'
     and build_ends_at <= now()
     and now() < build_ends_at + interval '5 minutes'
     and submitted_at is null;

  return (select status from public.build_sessions where id = p_session_id);
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. Wildcard secrecy (§1.4)
-- ════════════════════════════════════════════════════════════════════════════

-- The only path to a wildcard payload.
--
-- Refuses unless the caller is on a team whose build timer has already expired.
-- There is no parameter a client can use to ask for it earlier, and the check is
-- on the session's own timestamps rather than anything the caller supplies.
create or replace function public.reveal_wildcard_scenario(p_scenario_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_scenario   record;
  v_is_member  boolean;
  v_expired    boolean;
  v_assigned   boolean;
begin
  select s.id, s.hackathon_id, s.title, s.is_wildcard, s.revealed_at,
         s.assigned_to, s.difficulty, h.hackathon_type
    into v_scenario
    from public.hackathon_scenarios s
    join public.hackathons h on h.id = s.hackathon_id
   where s.id = p_scenario_id;

  if v_scenario.id is null then
    raise exception 'Scenario not found.' using errcode = 'P0002';
  end if;

  -- Non-wildcard scenarios are just scenarios; the payload is not sealed.
  if v_scenario.is_wildcard = false then
    return jsonb_build_object('id', v_scenario.id, 'title', v_scenario.title,
                              'is_wildcard', false, 'payload', null);
  end if;

  if not public.is_admin() then
    v_is_member := exists (
      select 1 from public.build_sessions bs
      where bs.hackathon_id = v_scenario.hackathon_id
        and public.is_team_member(bs.team_id)
    );
    if not v_is_member then
      raise exception 'Not your simulation.' using errcode = '42501';
    end if;

    -- Assigned-scenario check: if the admin pinned one scenario to one session,
    -- only that session's team may read it.
    if v_scenario.assigned_to is not null then
      v_assigned := exists (
        select 1 from public.build_sessions bs
        where bs.id = v_scenario.assigned_to
          and public.is_team_member(bs.team_id)
      );
      if not v_assigned then
        raise exception 'Not your simulation.' using errcode = '42501';
      end if;
    end if;

    -- The reveal condition. This is the whole of §1.4's secrecy rule.
    v_expired := exists (
      select 1 from public.build_sessions bs
      where bs.hackathon_id = v_scenario.hackathon_id
        and public.is_team_member(bs.team_id)
        and bs.build_ends_at <= now()
    );
    if not v_expired then
      raise exception 'That scenario has not been revealed yet.' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'id',         v_scenario.id,
    'title',      v_scenario.title,
    'is_wildcard', true,
    'revealed_at', v_scenario.revealed_at,
    'payload',    (select w.payload from public.hackathon_wildcards w
                    where w.scenario_id = v_scenario.id)
  );
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. Format-driven required fields (§1.4)
-- ════════════════════════════════════════════════════════════════════════════

-- The participant UI is supposed to change shape by format, but it must not
-- decide that on its own — otherwise a client can render "fixed problem" while
-- the server expects the open-innovation fields. The requirement list is derived
-- here and the client renders whatever it is told.
create or replace function public.required_fields_for_type(p_type text)
returns text[]
language sql
immutable
as $$
  select case p_type
    when 'open_innovation' then array[
      'identified_problem', 'why_it_matters', 'target_users', 'pain_point',
      'proposed_solution', 'expected_outcome', 'key_features', 'tech_stack',
      'github_url', 'live_demo_url', 'contributions', 'ai_tools_used'
    ]::text[]
    when 'theme_based' then array[
      'theme', 'problem', 'solution', 'theme_alignment',
      'github_url', 'contributions'
    ]::text[]
    when 'industry_scenario' then array[
      'scenario_interpretation', 'business_problem', 'proposed_solution',
      'constraints', 'expected_outcome', 'github_url', 'contributions'
    ]::text[]
    when 'government_public_problem' then array[
      'public_problem', 'affected_users', 'proposed_solution', 'constraints',
      'expected_outcome', 'github_url', 'contributions'
    ]::text[]
    when 'technology_challenge' then array[
      'technology', 'why_selected', 'problem_solved', 'implementation',
      'expected_outcome', 'github_url', 'contributions'
    ]::text[]
    else array[
      'project_name', 'project_description', 'solution', 'key_features',
      'tech_stack', 'github_url', 'live_demo_url', 'contributions'
    ]::text[]
  end;
$$;

-- The brief a session is actually running, with everything the client is
-- permitted to see. A wildcard contributes no scenario text here — only its
-- title — so this function is safe to call at any time.
create or replace function public.session_brief(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_row record;
  v_fields text[];
begin
  select s.id, s.team_id, s.status, s.build_ends_at,
         h.id as hackathon_id, h.name, h.hackathon_type, h.problem_statement,
         h.description, h.theme, h.domain, h.scenario, h.context,
         h.target_users, h.constraints, h.expected_outcome, h.expected_outcomes,
         h.evaluation_criteria, h.difficulty, h.hints,
         h.problem_discovery_required, h.ai_assistance_allowed,
         h.requirements, h.simulation_duration_minutes
    into v_row
    from public.build_sessions s
    join public.hackathons h on h.id = s.hackathon_id
   where s.id = p_session_id;

  if v_row.id is null then
    raise exception 'Simulation not found.' using errcode = 'P0002';
  end if;

  if not (public.is_admin() or public.is_team_member(v_row.team_id)) then
    raise exception 'Not your simulation.' using errcode = '42501';
  end if;

  v_fields := public.required_fields_for_type(v_row.hackathon_type);

  return jsonb_build_object(
    'hackathon', jsonb_build_object(
      'id', v_row.hackathon_id,
      'name', v_row.name,
      'description', v_row.description,
      'hackathon_type', v_row.hackathon_type,
      'theme', v_row.theme,
      'domain', v_row.domain,
      -- Wildcard text is deliberately absent. §1.4 forbids it reaching the
      -- client before the reveal, and a brief endpoint is exactly the kind of
      -- thing that leaks.
      'scenario', case when v_row.hackathon_type = 'wildcard' then null
                      else v_row.scenario end,
      'context', case when v_row.hackathon_type = 'wildcard' then null
                     else v_row.context end,
      'problem_statement', case when v_row.hackathon_type = 'wildcard' then null
                               else v_row.problem_statement end,
      'requirements', v_row.requirements,
      'target_users', v_row.target_users,
      'constraints', v_row.constraints,
      'expected_outcome', v_row.expected_outcome,
      'expected_outcomes', v_row.expected_outcomes,
      'evaluation_criteria', v_row.evaluation_criteria,
      'difficulty', v_row.difficulty,
      'hints', v_row.hints,
      'problem_discovery_required', v_row.problem_discovery_required,
      'ai_assistance_allowed', v_row.ai_assistance_allowed
    ),
    'required_fields', to_jsonb(v_fields),
    'clock', public.session_clock(p_session_id)
  );
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 4. Problem discovery (§1.3, 25)
-- ════════════════════════════════════════════════════════════════════════════

-- Idempotent by construction: one draft per session, enforced by a partial
-- unique index, so a double-click or a retried request cannot create two.
create or replace function public.save_problem_discovery(
  p_session_id      uuid,
  p_problem_statement text,
  p_why_it_matters    text default null,
  p_target_users      text default null,
  p_pain_point        text default null,
  p_proposed_solution text default null,
  p_expected_outcome  text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
  v_id      uuid;
begin
  select team_id into v_team_id
    from public.build_sessions where id = p_session_id;

  if v_team_id is null then
    raise exception 'Simulation not found.' using errcode = 'P0002';
  end if;
  if not (public.is_admin() or public.is_team_member(v_team_id)) then
    raise exception 'Not your simulation.' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.problem_discoveries
     where session_id = p_session_id and status = 'locked'
  ) then
    raise exception 'The problem has been locked and cannot be changed.'
      using errcode = '42501';
  end if;

  insert into public.problem_discoveries (
    session_id, team_id,
    problem_statement, why_it_matters, target_users,
    pain_point, proposed_solution, expected_outcome
  )
  values (
    p_session_id, v_team_id,
    coalesce(p_problem_statement, ''), coalesce(p_why_it_matters, ''),
    coalesce(p_target_users, ''), coalesce(p_pain_point, ''),
    coalesce(p_proposed_solution, ''), coalesce(p_expected_outcome, '')
  )
  on conflict (session_id) where status = 'draft'
  do update set
    problem_statement = excluded.problem_statement,
    why_it_matters    = excluded.why_it_matters,
    target_users      = excluded.target_users,
    pain_point        = excluded.pain_point,
    proposed_solution = excluded.proposed_solution,
    expected_outcome  = excluded.expected_outcome,
    updated_at        = now()
  returning id into v_id;

  return v_id;
end;
$$;

-- Locking is one-way and checked against the build timer: §1.3's flow has a
-- "Lock Problem" step, but the lock cannot outlive the build or be undone.
create or replace function public.lock_problem_discovery(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    record;
  v_missing text[];
begin
  select d.id, d.team_id, d.status, d.problem_statement, d.why_it_matters,
         d.target_users, d.pain_point, d.proposed_solution, d.expected_outcome,
         bs.build_ends_at
    into v_row
    from public.problem_discoveries d
    join public.build_sessions bs on bs.id = d.session_id
   where d.session_id = p_session_id and d.status <> 'locked'
   order by d.created_at desc
   limit 1;

  if v_row.id is null then
    raise exception 'No problem discovery to lock.' using errcode = 'P0002';
  end if;
  if not (public.is_admin() or public.is_team_member(v_row.team_id)) then
    raise exception 'Not your simulation.' using errcode = '42501';
  end if;

  -- Every open-innovation field is required, and the client is told exactly
  -- which ones are missing rather than being handed a generic error.
  v_missing := array_remove(array[
    case when length(trim(v_row.problem_statement)) > 0 then null else 'identified_problem' end,
    case when length(trim(v_row.why_it_matters))    > 0 then null else 'why_it_matters'    end,
    case when length(trim(v_row.target_users))      > 0 then null else 'target_users'      end,
    case when length(trim(v_row.pain_point))        > 0 then null else 'pain_point'        end,
    case when length(trim(v_row.proposed_solution)) > 0 then null else 'proposed_solution' end,
    case when length(trim(v_row.expected_outcome))  > 0 then null else 'expected_outcome'  end
  ], null);

  if array_length(v_missing, 1) is not null then
    return jsonb_build_object('ok', false, 'missing_fields', to_jsonb(v_missing));
  end if;

  -- The previous draft becomes the locked record; only one lock survives,
  -- enforced by a partial unique index rather than by this function alone.
  update public.problem_discoveries
     set status = 'draft' where session_id = p_session_id and id = v_row.id;

  update public.problem_discoveries
     set status = 'locked', submitted_at = now(), locked_at = now(), updated_at = now()
   where id = v_row.id;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'locked_at', now());
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 5. Submission lock (§13.5, 25)
-- ════════════════════════════════════════════════════════════════════════════

-- The only way a submission reaches 'submitted'. It is the join point of §13:
-- the window is checked here, the rows are frozen, and the caller is told to
-- start analysis. Idempotent — a retried click sees 'submitted' and returns the
-- same answer rather than failing or duplicating.
create or replace function public.lock_submission(p_submission_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub   record;
  v_phase text;
begin
  select sub.id, sub.session_id, sub.team_id, sub.status, sub.github_url,
         bs.build_ends_at, bs.github_submission_ends_at, bs.submitted_at
    into v_sub
    from public.submissions sub
    join public.build_sessions bs on bs.id = sub.session_id
   where sub.id = p_submission_id;

  if v_sub.id is null then
    raise exception 'Submission not found.' using errcode = 'P0002';
  end if;
  if not (public.is_admin() or public.is_team_member(v_sub.team_id)) then
    raise exception 'Not your team.' using errcode = '42501';
  end if;

  -- Idempotent: already locked.
  if v_sub.status = 'submitted' then
    return jsonb_build_object('ok', true, 'already_submitted', true,
                              'submitted_at', v_sub.submitted_at);
  end if;

  if length(trim(coalesce(v_sub.github_url, ''))) = 0 then
    raise exception 'A GitHub repository URL is required to submit.'
      using errcode = '23514';
  end if;

  -- The window is evaluated by the database clock. A late submission is refused
  -- regardless of what the client believes about time.
  if v_sub.build_ends_at is null or now() < v_sub.build_ends_at then
    raise exception 'The build timer has not finished yet.' using errcode = '42501';
  end if;

  if now() >= coalesce(v_sub.github_submission_ends_at,
                       v_sub.build_ends_at + interval '5 minutes') then
    perform public.sync_session_phase(v_sub.session_id);
    raise exception 'The submission window has closed.' using errcode = '42501';
  end if;

  -- Freeze the record and the session in one transaction (§18).
  update public.submissions
     set status = 'submitted', submitted_at = now(), updated_at = now()
   where id = p_submission_id;

  update public.build_sessions
     set status = 'submitted', submitted_at = now(), updated_at = now()
   where id = v_sub.session_id;

  insert into public.submission_events (submission_id, event_type, created_by)
  values (p_submission_id, 'submitted', auth.uid());

  -- A locked problem discovery freezes with it.
  update public.problem_discoveries
     set status = 'locked', locked_at = coalesce(locked_at, now()), updated_at = now()
   where session_id = v_sub.session_id and status = 'submitted';

  return jsonb_build_object(
    'ok', true, 'already_submitted', false,
    'submitted_at', now(),
    -- The caller starts background analysis; §13.4 forbids AI work inside the
    -- window, so this is a signal, not a step.
    'analysis_required', true
  );
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 6. Audit logging (§15.12)
-- ════════════════════════════════════════════════════════════════════════════

-- Redacts anything that looks like a credential before it reaches the log.
-- §15.12 forbids secrets in metadata, and a log table is exactly the sort of
-- thing that ends up in a support ticket.
create or replace function public.redact_secrets(p_text text)
returns text
language sql
immutable
as $$
  select case
    when p_text is null then null
    else regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(p_text,
            '(sk-[A-Za-z0-9_-]{12,})', '[REDACTED]', 'g'),
          '(gh[pousr]_[A-Za-z0-9]{20,})', '[REDACTED]', 'g'),
          '(Bearer\s+)[A-Za-z0-9._-]{12,}', '\1[REDACTED]', 'gi'),
          '((password|secret|token|api[_-]?key)\s*[:=]\s*)\S+',
          '\1[REDACTED]', 'gi')
  end;
$$;

create or replace function public.write_audit_log(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_entity_name text default null,
  p_reason      text default null,
  p_metadata    jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception 'Admin only.' using errcode = '42501';
  end if;

  insert into public.admin_audit_logs (
    admin_user_id, action, entity_type, entity_id, entity_name, reason, metadata
  )
  values (
    auth.uid(), p_action, p_entity_type, p_entity_id, p_entity_name,
    public.redact_secrets(p_reason),
    -- Metadata is redacted as text before it becomes jsonb: stripping after the
    -- fact would miss a key nested inside a value.
    jsonb_build_object('redacted', public.redact_secrets(p_metadata::text))
  )
  returning id into v_id;

  return v_id;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 7. Dependency-aware, audited deletion (§15, §17, §18)
-- ════════════════════════════════════════════════════════════════════════════

-- What would be destroyed. The client shows this before asking for
-- confirmation — §15.5 forbids a silent cascade, and the only way to honour
-- that is to make the cost of deletion queryable.
create or replace function public.deletion_impact(p_entity_type text, p_entity_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_out jsonb;
begin
  if not public.is_admin() then
    raise exception 'Admin only.' using errcode = '42501';
  end if;

  v_out := case p_entity_type
    when 'hackathon' then jsonb_build_object(
      'scenarios',   (select count(*) from public.hackathon_scenarios     where hackathon_id = p_entity_id),
      'sessions',    (select count(*) from public.build_sessions          where hackathon_id = p_entity_id),
      'submissions', (select count(*) from public.submissions             where hackathon_id = p_entity_id),
      'requirement_maps', (select count(*) from public.hackathon_requirement_maps where hackathon_id = p_entity_id)
    )
    when 'simulation' then jsonb_build_object(
      'checkpoints', (select count(*) from public.build_checkpoints where session_id = p_entity_id),
      'submissions', (select count(*) from public.submissions        where session_id = p_entity_id),
      'problem_discoveries', (select count(*) from public.problem_discoveries where session_id = p_entity_id)
    )
    when 'submission' then jsonb_build_object(
      'members',        (select count(*) from public.submission_members   where submission_id = p_entity_id),
      'repository',     (select count(*) from public.repositories          where submission_id = p_entity_id),
      'files',          (select count(*) from public.repository_files      where repository_id in
                           (select id from public.repositories where submission_id = p_entity_id)),
      'chunks',         (select count(*) from public.code_chunks          where repository_id in
                           (select id from public.repositories where submission_id = p_entity_id)),
      'ai_analyses',    (select count(*) from public.ai_analyses           where submission_id = p_entity_id),
      'ai_usage',       (select count(*) from public.ai_usage              where submission_id = p_entity_id),
      'requirement_evaluations', (select count(*) from public.requirement_evaluations where submission_id = p_entity_id),
      'project_reviews',(select count(*) from public.project_reviews       where submission_id = p_entity_id),
      'findings',       (select count(*) from public.project_review_findings f
                           join public.project_reviews r on r.id = f.project_review_id
                          where r.submission_id = p_entity_id),
      'project_knowledge', (select count(*) from public.project_knowledge where submission_id = p_entity_id),
      'member_knowledge',  (select count(*) from public.member_project_knowledge where submission_id = p_entity_id),
      'question_targets',  (select count(*) from public.question_targets   where submission_id = p_entity_id),
      'claims',            (select count(*) from public.submission_claims  where submission_id = p_entity_id)
    )
    when 'repository' then jsonb_build_object(
      'files',  (select count(*) from public.repository_files where repository_id = p_entity_id),
      'chunks', (select count(*) from public.code_chunks     where repository_id = p_entity_id),
      'project_knowledge', (select count(*) from public.project_knowledge where repository_id = p_entity_id)
    )
    when 'team' then jsonb_build_object(
      'members',    (select count(*) from public.team_members    where team_id = p_entity_id),
      'sessions',   (select count(*) from public.build_sessions  where team_id = p_entity_id),
      'submissions',(select count(*) from public.submissions     where team_id = p_entity_id)
    )
    else '{}'::jsonb
  end;

  return jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id,
                           'dependents', v_out);
end;
$$;

-- Archive / soft delete / restore, in one place so every caller gets the same
-- behaviour and the same audit trail. §15.6 and §15.13.
--
-- `p_mode` is archive | delete | restore. `archive` and `delete` both set
-- deleted_at — the difference is only the audit action, because a "soft delete"
-- that hard-deletes would be the exact failure §36 warns about.
create or replace function public.manage_entity(
  p_entity_type text,
  p_entity_id   uuid,
  p_mode        text,
  p_reason      text default null,
  p_confirm     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action  text;
  v_name    text;
  v_missing text[] := '{}';
begin
  -- §15.10: the role comes from the database, never from the request.
  if not public.is_admin() then
    raise exception 'Admin only.' using errcode = '42501';
  end if;

  if p_mode not in ('archive', 'delete', 'restore', 'permanent') then
    raise exception 'Unknown deletion mode.' using errcode = '22023';
  end if;

  -- §15.4: high-impact entities require a typed confirmation, and it is the
  -- entity's own name, so it cannot be copy-pasted between records.
  if p_mode in ('archive', 'delete', 'permanent') and p_entity_type = 'hackathon' then
    select name into v_name from public.hackathons where id = p_entity_id;
    v_missing := array_remove(array[
      case when p_confirm is null or length(trim(p_confirm)) = 0 then 'confirmation' end,
      case when v_name is not null and p_confirm is distinct from v_name then 'name_mismatch' end
    ], null);

    if array_length(v_missing, 1) is not null then
      return jsonb_build_object(
        'ok', false, 'requires_confirmation', true,
        'expected', v_name, 'reason', to_jsonb(v_missing));
    end if;
  end if;

  v_action := case p_mode
    when 'archive'  then 'archived'
    when 'delete'   then 'deleted'
    when 'permanent' then 'permanently_deleted'
    else 'restored'
  end;

  -- One transaction (§18). Either the row changes and the log is written, or
  -- neither happens.
  case p_entity_type
    when 'hackathon' then
      if p_mode = 'permanent' then
        -- Only reachable for a hackathon with nothing attached: `on delete
        -- restrict` on build_sessions/submissions is the backstop, and this
        -- check turns a raw constraint violation into an explanation.
        if exists (select 1 from public.build_sessions where hackathon_id = p_entity_id) then
          return jsonb_build_object('ok', false, 'blocked',
            'reason', 'This hackathon still has simulations. Archive it instead.');
        end if;
        delete from public.hackathons where id = p_entity_id;
      else
        update public.hackathons
           set deleted_at = case when p_mode = 'restore' then null else now() end,
               deleted_by = case when p_mode = 'restore' then null else auth.uid() end,
               updated_at = now()
         where id = p_entity_id;
        select name into v_name from public.hackathons where id = p_entity_id;
      end if;

    when 'simulation' then
      if p_mode = 'permanent' then
        delete from public.build_sessions where id = p_entity_id;
      else
        update public.build_sessions
           set deleted_at = case when p_mode = 'restore' then null else now() end,
               deleted_by = case when p_mode = 'restore' then null else auth.uid() end,
               updated_at = now()
         where id = p_entity_id;
      end if;

    when 'submission' then
      if p_mode = 'permanent' then
        delete from public.submissions where id = p_entity_id;
      else
        update public.submissions
           set deleted_at = case when p_mode = 'restore' then null else now() end,
               deleted_by = case when p_mode = 'restore' then null else auth.uid() end,
               updated_at = now()
         where id = p_entity_id;
      end if;

    when 'team' then
      if p_mode = 'permanent' then
        delete from public.teams where id = p_entity_id;
      else
        update public.teams
           set deleted_at = case when p_mode = 'restore' then null else now() end,
               deleted_by = case when p_mode = 'restore' then null else auth.uid() end,
           updated_at = now()
         where id = p_entity_id;
      end if;

    when 'repository' then
      if p_mode = 'permanent' then
        delete from public.repositories where id = p_entity_id;
      else
        update public.repositories
           set deleted_at = case when p_mode = 'restore' then null else now() end,
               deleted_by = case when p_mode = 'restore' then null else auth.uid() end,
               updated_at = now()
         where id = p_entity_id;
      end if;

    when 'project_knowledge' then
      -- §15.8: knowledge is archived, never destroyed. A permanent delete of
      -- project knowledge is refused outright rather than merely discouraged.
      if p_mode = 'permanent' then
        return jsonb_build_object('ok', false, 'blocked',
          'reason', 'Project knowledge is historical. Archive the version instead.');
      end if;
      update public.project_knowledge
         set deleted_at = case when p_mode = 'restore' then null else now() end,
             deleted_by = case when p_mode = 'restore' then null else auth.uid() end,
             updated_at = now()
       where id = p_entity_id;

    when 'ai_analysis' then
      -- §15.8 permits a permanent delete of disposable cache.
      if p_mode = 'permanent' then
        delete from public.ai_analyses where id = p_entity_id;
      else
        return jsonb_build_object('ok', false, 'blocked',
          'reason', 'AI analyses are historical records. Use permanent delete to purge cache.');
      end if;

    when 'audit_log' then
      -- The audit log is not deletable through its own delete endpoint. An
      -- audit trail that can delete itself is not an audit trail.
      raise exception 'Audit log entries cannot be deleted.' using errcode = '42501';

    else
      raise exception 'Unknown entity type.' using errcode = '22023';
  end case;

  perform public.write_audit_log(
    v_action, p_entity_type, p_entity_id, v_name, p_reason,
    jsonb_build_object('mode', p_mode)
  );

  return jsonb_build_object('ok', true, 'action', v_action,
                           'entity_type', p_entity_type, 'entity_id', p_entity_id);
end;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- 8. Grants
-- ════════════════════════════════════════════════════════════════════════════

-- Execute is granted; table access is not. The functions above are the only
-- route to these tables, which is what makes the wildcard payload unreachable
-- by a direct select.
grant execute on function public.session_clock(uuid) to authenticated;
grant execute on function public.sync_session_phase(uuid) to authenticated;
grant execute on function public.open_github_window(uuid) to authenticated;
grant execute on function public.reveal_wildcard_scenario(uuid) to authenticated;
grant execute on function public.session_brief(uuid) to authenticated;
grant execute on function public.required_fields_for_type(text) to authenticated, anon;
grant execute on function public.save_problem_discovery(uuid, text, text, text, text, text, text) to authenticated;
grant execute on function public.lock_problem_discovery(uuid) to authenticated;
grant execute on function public.lock_submission(uuid) to authenticated;
grant execute on function public.deletion_impact(text, uuid) to authenticated;
grant execute on function public.manage_entity(text, uuid, text, text, text) to authenticated;
grant execute on function public.write_audit_log(text, text, uuid, text, text, jsonb) to authenticated;
grant execute on function public.redact_secrets(text) to authenticated, anon;

-- The service role is how the edge functions reach these tables at all.
grant all on public.hackathon_scenarios      to service_role;
grant all on public.hackathon_wildcards      to service_role;
grant all on public.problem_discoveries      to service_role;
grant all on public.project_knowledge        to service_role;
grant all on public.member_project_knowledge to service_role;
grant all on public.question_targets         to service_role;
grant all on public.submission_claims        to service_role;
grant all on public.admin_audit_logs         to service_role;
