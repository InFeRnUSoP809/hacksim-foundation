-- ────────────────────────────────────────────────────────────────────────────
-- 008_admin_playground.sql
--
-- An admin test bench for the analysis pipeline.
--
-- The normal path to an AI review runs through a hackathon, a team, an
-- 8-hour build and a submission window — which makes pipeline changes slow to
-- verify and clutters real data with tests. These functions build the same
-- shape the pipeline expects (session → submission with a GitHub URL) directly
-- and mark it clearly as disposable, so an admin can scan any public
-- repository and read the review in seconds.
--
-- Everything created here is named ADMIN-PLAYGROUND-% and cascades away in one
-- call, so test rows can never be mistaken for real submissions (§15: no
-- accidental data, no orphaned tests).
--
-- Why the session is born 'completed' with no window: the playground is not a
-- simulation. The timers, checkpoints and submission window are the parts
-- being bypassed — the pipeline under test starts at a locked submission with
-- a repository URL, and that is exactly the state these rows describe.
--
-- Admin-only throughout (§69): every entry point re-checks is_admin() from the
-- JWT, never from the request body.
-- ────────────────────────────────────────────────────────────────────────────

-- Creates the throwaway harness and returns the ids the admin UI needs.
create or replace function public.create_admin_playground_submission(
  p_github_url  text,
  p_project_name text default 'Playground Test'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin        uuid      := auth.uid();
  v_hackathon_id uuid;
  v_team_id      uuid;
  v_session_id   uuid;
  v_submission_id uuid;
  v_name         text := left(trim(coalesce(p_project_name, 'Playground Test')), 120);
begin
  if not public.is_admin() then
    raise exception 'Admin only.' using errcode = '42501';
  end if;

  if not public.is_github_repo_url(trim(coalesce(p_github_url, ''))) then
    raise exception 'Enter a GitHub repository URL, like https://github.com/user/repo'
      using errcode = '23514';
  end if;

  -- The shared system hackathon: a draft with practice off, so it never appears
  -- as a live option for students and is invisible to every student query.
  select id into v_hackathon_id
    from public.hackathons
   where name = 'ADMIN-PLAYGROUND-SYSTEM'
   limit 1;

  if v_hackathon_id is null then
    insert into public.hackathons (
      name, problem_statement, requirements, constraints,
      expected_outcome, evaluation_criteria,
      simulation_duration_minutes,
      github_submission_window_enabled, github_submission_window_minutes,
      status, practice_enabled
    ) values (
      'ADMIN-PLAYGROUND-SYSTEM',
      'Admin analysis playground — not a real hackathon.',
      '', '', '', '',
      1,                              -- minimal duration; never used
      false, 5,                       -- no submission window: not a run
      'draft', false                  -- draft + practice off = student-invisible
    )
    returning id into v_hackathon_id;
  end if;

  -- One disposable team per test, named so cleanup can find it.
  -- Deliberately NO team_members row: 002 enforces one team per user
  -- (team_members_one_team_per_user), and the admin almost always already
  -- belongs to a real team, so joining them here aborts the whole RPC. The
  -- pipeline never needs it — requireTeamAccess, lock_submission,
  -- submission_analysis and every RLS read have an is_admin() bypass.
  insert into public.teams (name, created_by)
  values ('ADMIN-PLAYGROUND-' || substr(md5(random()::text), 1, 10), v_admin)
  returning id into v_team_id;

  -- The harness session: born finished, no window, no deadline in the future.
  insert into public.build_sessions (
    hackathon_id, team_id, started_by,
    started_at, ends_at, build_ends_at,
    github_submission_window_enabled, github_submission_window_minutes,
    status
  ) values (
    v_hackathon_id, v_team_id, v_admin,
    now(), now(), now(),
    false, 5,
    'completed'                     -- the pipeline's assumed state: run over
  )
  returning id into v_session_id;

  insert into public.submissions (
    session_id, hackathon_id, team_id, submitted_by,
    project_name, project_description, github_url,
    status, submitted_at
  ) values (
    v_session_id, v_hackathon_id, v_team_id, v_admin,
    v_name,
    'Admin playground test — not a real student submission.',
    trim(p_github_url),
    'submitted',                    -- locked, so analysis may run
    now()
  )
  returning id into v_submission_id;

  return jsonb_build_object(
    'submission_id',  v_submission_id,
    'session_id',     v_session_id,
    'team_id',        v_team_id,
    'hackathon_id',   v_hackathon_id,
    'github_url',     trim(p_github_url),
    'project_name',   v_name
  );
end;
$$;

-- Lists the live playground submissions, newest first, for the admin UI.
create or replace function public.admin_playground_list()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'submission_id', sub.id,
           'project_name',  sub.project_name,
           'github_url',    sub.github_url,
           'created_at',    sub.created_at
         ) order by sub.created_at desc), '[]'::jsonb)
  from public.submissions sub
  join public.build_sessions s on s.id = sub.session_id
  join public.hackathons h    on h.id = s.hackathon_id
  where h.name = 'ADMIN-PLAYGROUND-SYSTEM'
    and public.is_admin();
$$;

-- Removes every playground team (and, by cascade, their sessions, submissions,
-- repositories, files, chunks, evidence, analyses and knowledge). Real data is
-- untouched: only rows under a ADMIN-PLAYGROUND-% team can match.
create or replace function public.admin_playground_reset()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_removed integer;
begin
  if not public.is_admin() then
    raise exception 'Admin only.' using errcode = '42501';
  end if;

  with doomed as (
    delete from public.teams
     where name like 'ADMIN-PLAYGROUND-%'
     returning 1
  )
  select count(*) into v_removed from doomed;

  return v_removed;
end;
$$;

grant execute on function public.create_admin_playground_submission(text, text) to authenticated;
grant execute on function public.admin_playground_list() to authenticated;
grant execute on function public.admin_playground_reset() to authenticated;
