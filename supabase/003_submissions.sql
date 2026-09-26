-- ============================================================================
-- 003 — submissions, submission_members, submission_events
-- ============================================================================
-- Phase 4. Run after 002_hackathons_teams_sessions.sql.
--
-- Two invariants are enforced here rather than in React:
--   BUSINESS RULE 7 — one submission per build session (unique index)
--   BUSINESS RULE 8 — a submitted project is read-only (a BEFORE UPDATE
--                      trigger rejects any change to a 'submitted' row)
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- submissions
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.submissions (
  id                   uuid primary key default gen_random_uuid(),
  session_id           uuid        not null references public.build_sessions (id) on delete cascade,
  hackathon_id         uuid        not null references public.hackathons (id) on delete restrict,
  team_id              uuid        not null references public.teams (id) on delete cascade,
  submitted_by         uuid        not null references public.profiles (id) on delete cascade,

  project_name         text        not null default '',
  project_description  text        not null default '',
  github_url           text,
  live_demo_url        text,
  tech_stack           text        not null default '',
  key_features         text        not null default '',

  status               text        not null default 'draft'
                                 check (status in ('draft', 'submitted')),

  submitted_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- BUSINESS RULE 7: exactly one official submission per build session.
  unique (session_id)
);

create index if not exists submissions_session_idx    on public.submissions (session_id);
create index if not exists submissions_hackathon_idx on public.submissions (hackathon_id);
create index if not exists submissions_team_idx      on public.submissions (team_id);
create index if not exists submissions_submitter_idx on public.submissions (submitted_by);
create index if not exists submissions_status_idx    on public.submissions (status);

drop trigger if exists submissions_touch on public.submissions;
create trigger submissions_touch
  before update on public.submissions
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- submission_members — per-person contribution and AI disclosure
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.submission_members (
  id                       uuid primary key default gen_random_uuid(),
  submission_id            uuid        not null references public.submissions (id) on delete cascade,
  user_id                  uuid        not null references public.profiles (id) on delete cascade,

  contribution_description text        not null default '',
  contribution_areas       text[]      not null default '{}',
  planned_responsibilities text        not null default '',
  ai_tools_used            text        not null default '',
  ai_usage_description     text        not null default '',

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (submission_id, user_id)
);

create index if not exists submission_members_submission_idx on public.submission_members (submission_id);
create index if not exists submission_members_user_idx       on public.submission_members (user_id);

drop trigger if exists submission_members_touch on public.submission_members;
create trigger submission_members_touch
  before update on public.submission_members
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- submission_events — a light audit trail
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.submission_events (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid        not null references public.submissions (id) on delete cascade,
  event_type    text        not null check (event_type in
                      ('draft_created', 'draft_updated', 'submitted')),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists submission_events_submission_idx
  on public.submission_events (submission_id);


-- ────────────────────────────────────────────────────────────────────────────
-- Submission lock
-- ────────────────────────────────────────────────────────────────────────────
-- BUSINESS RULE 8. Once a submission is 'submitted' the row is frozen. The
-- trigger runs below RLS, so no policy or client call can route around it, and
-- no admin override exists in this phase.
create or replace function public.lock_submitted_row()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;
  return new;
end;
$$;

drop trigger if exists submissions_lock on public.submissions;
create trigger submissions_lock
  before update on public.submissions
  for each row execute function public.lock_submitted_row();

-- The same freeze applies to each member's contribution row, so a student
-- cannot edit their disclosure after the team has submitted. The lookup lives
-- inside the function body because a trigger WHEN clause may not contain a
-- subquery.
create or replace function public.lock_submission_member_row()
returns trigger
language plpgsql
as $$
begin
  if (select s.status from public.submissions s where s.id = old.submission_id)
       = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;
  return new;
end;
$$;

drop trigger if exists submission_members_lock on public.submission_members;
create trigger submission_members_lock
  before update on public.submission_members
  for each row execute function public.lock_submission_member_row();


-- ────────────────────────────────────────────────────────────────────────────
-- URL validation
-- ────────────────────────────────────────────────────────────────────────────
-- Phase 4 validates shape only. No repository is fetched or analysed.
create or replace function public.is_github_repo_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$';
$$;

create or replace function public.is_http_url(p_url text)
returns boolean
language sql
immutable
as $$
  select p_url ~ '^https?://[^\s/$.?#].[^\s]*$';
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- RPC — create or fetch the draft
-- ────────────────────────────────────────────────────────────────────────────
-- A student can hold exactly one draft per session. Creating it also creates a
-- submission_members row for every current team member, so each person has
-- somewhere to describe their own contribution.
create or replace function public.ensure_draft_submission(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s          public.build_sessions;
  v_sub_id   uuid;
  v_sub_status text;
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not a member of this team.';
  end if;

  select id, status into v_sub_id, v_sub_status
  from public.submissions where session_id = p_session_id;

  if v_sub_id is not null then
    -- Already exists. Re-running is safe and never resurrects a finalised one.
    return v_sub_id;
  end if;

  if s.status = 'expired' then
    raise exception 'Simulation has expired.';
  end if;

  insert into public.submissions
    (session_id, hackathon_id, team_id, submitted_by)
  values (s.id, s.hackathon_id, s.team_id, auth.uid())
  returning id into v_sub_id;

  insert into public.submission_members (submission_id, user_id)
  select v_sub_id, tm.user_id
  from public.team_members tm
  where tm.team_id = s.team_id
  on conflict do nothing;

  insert into public.submission_events (submission_id, event_type, created_by)
  values (v_sub_id, 'draft_created', auth.uid());

  return v_sub_id;
end;
$$;

-- Save the draft. Refuses once the submission is finalised.
create or replace function public.save_submission_draft(
  p_session_id           uuid,
  p_project_name         text,
  p_project_description  text,
  p_github_url           text,
  p_live_demo_url        text,
  p_tech_stack           text,
  p_key_features         text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  s        public.build_sessions;
  v_sub_id uuid;
  v_status text;
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not a member of this team.';
  end if;

  v_sub_id := public.ensure_draft_submission(p_session_id);

  select status into v_status from public.submissions where id = v_sub_id;
  if v_status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;

  -- Shape-only validation, same rules the client enforces.
  if p_github_url is not null and length(trim(p_github_url)) > 0
     and not public.is_github_repo_url(trim(p_github_url)) then
    raise exception 'Invalid GitHub URL.';
  end if;

  if p_live_demo_url is not null and length(trim(p_live_demo_url)) > 0
     and not public.is_http_url(trim(p_live_demo_url)) then
    raise exception 'Invalid live demo URL.';
  end if;

  if length(trim(coalesce(p_project_name, ''))) < 1 then
    raise exception 'Project name is required.';
  end if;

  update public.submissions
     set project_name    = trim(p_project_name),
         project_description = coalesce(p_project_description, ''),
         github_url      = nullif(trim(coalesce(p_github_url, '')), ''),
         live_demo_url   = nullif(trim(coalesce(p_live_demo_url, '')), ''),
         tech_stack      = coalesce(p_tech_stack, ''),
         key_features    = coalesce(p_key_features, '')
   where id = v_sub_id;

  insert into public.submission_events (submission_id, event_type, created_by)
  values (v_sub_id, 'draft_updated', auth.uid());

  return v_sub_id;
end;
$$;

-- Save only the caller's own contribution. A student can never write another
-- member's row: the user_id is always auth.uid().
create or replace function public.save_my_contribution(
  p_submission_id            uuid,
  p_contribution_description text,
  p_contribution_areas       text[],
  p_planned_responsibilities text,
  p_ai_tools_used            text,
  p_ai_usage_description     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_team   uuid;
begin
  select s.status, sess.team_id into v_status, v_team
  from public.submissions s
  join public.build_sessions sess on sess.id = s.session_id
  where s.id = p_submission_id;

  if v_status is null then
    raise exception 'Submission not found.';
  end if;

  if not public.is_team_member(v_team) then
    raise exception 'You are not a member of this team.';
  end if;

  if v_status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;

  update public.submission_members
     set contribution_description = coalesce(p_contribution_description, ''),
         contribution_areas       = coalesce(p_contribution_areas, '{}'),
         planned_responsibilities = coalesce(p_planned_responsibilities, ''),
         ai_tools_used            = coalesce(p_ai_tools_used, ''),
         ai_usage_description     = coalesce(p_ai_usage_description, '')
   where submission_id = p_submission_id
     and user_id = auth.uid();
end;
$$;

-- Final submission. Requires every member to have recorded a contribution, so
-- the AI contribution analysis in a later phase has real data to work with.
create or replace function public.finalize_submission(p_session_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sub_id   uuid;
  v_status   text;
  v_missing  bigint;
  v_sess     public.build_sessions;
begin
  select * into v_sess from public.build_sessions where id = p_session_id;

  if v_sess.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not public.is_team_member(v_sess.team_id) then
    raise exception 'You are not a member of this team.';
  end if;

  select id, status into v_sub_id, v_status
  from public.submissions where session_id = p_session_id;

  if v_sub_id is null then
    raise exception 'Save a draft before submitting.';
  end if;

  if v_status = 'submitted' then
    raise exception 'Submission already finalized.';
  end if;

  if length(trim(coalesce((select project_name from public.submissions
                           where id = v_sub_id), ''))) = 0 then
    raise exception 'Project name is required.';
  end if;

  select count(*) into v_missing
  from public.team_members tm
  left join public.submission_members sm
    on sm.submission_id = v_sub_id and sm.user_id = tm.user_id
  where tm.team_id = v_sess.team_id
    and length(trim(coalesce(sm.contribution_description, ''))) = 0;

  if v_missing > 0 then
    raise exception 'Every team member must add a contribution description before submitting.';
  end if;

  -- submitted_at is a server timestamp. After this the row is frozen by the
  -- lock trigger, and the session moves to 'submitted'.
  update public.submissions
     set status       = 'submitted',
         submitted_at = now(),
         submitted_by = auth.uid()
   where id = v_sub_id;

  update public.build_sessions set status = 'submitted' where id = p_session_id;

  insert into public.submission_events (submission_id, event_type, created_by)
  values (v_sub_id, 'submitted', auth.uid());

  return v_sub_id;
end;
$$;

-- Per-person contribution for a submission, joined to profiles and the
-- member's team role. SECURITY DEFINER is required: teammates must see each
-- other's names and disclosures, but a profile row is otherwise only visible
-- to its own owner.
create or replace function public.submission_roster(p_submission_id uuid)
returns table (
  member_id                uuid,
  user_id                  uuid,
  full_name                text,
  email                    text,
  team_role                text,
  contribution_description text,
  contribution_areas       text[],
  planned_responsibilities text,
  ai_tools_used            text,
  ai_usage_description     text
)
language sql
stable
security definer
set search_path = public
as $$
  select sm.id, sm.user_id, p.full_name, p.email,
         coalesce(tm.role, 'Other'),
         sm.contribution_description, sm.contribution_areas,
         sm.planned_responsibilities, sm.ai_tools_used, sm.ai_usage_description
  from public.submission_members sm
  join public.submissions sub  on sub.id = sm.submission_id
  join public.build_sessions s on s.id = sub.session_id
  join public.profiles p       on p.id = sm.user_id
  left join public.team_members tm
         on tm.team_id = s.team_id and tm.user_id = sm.user_id
  where sm.submission_id = p_submission_id
    and (public.is_team_member(s.team_id) or public.is_admin())
  order by sm.created_at;
$$;

-- Admin listing for /admin/submissions.
create or replace function public.admin_submissions()
returns table (
  id            uuid,
  session_id    uuid,
  project_name  text,
  team_name     text,
  hackathon_name text,
  status        text,
  github_url    text,
  live_demo_url text,
  submitted_at  timestamptz,
  member_count  bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select sub.id, sub.session_id, sub.project_name,
         t.name, h.name, sub.status::text, sub.github_url, sub.live_demo_url,
         sub.submitted_at,
         (select count(*) from public.submission_members sm
          where sm.submission_id = sub.id)
  from public.submissions sub
  join public.teams t       on t.id = sub.team_id
  join public.hackathons h on h.id = sub.hackathon_id
  where public.is_admin()
  order by sub.created_at desc;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ────────────────────────────────────────────────────────────────────────────

-- submissions ---------------------------------------------------------------
alter table public.submissions enable row level security;

drop policy if exists submissions_read on public.submissions;
create policy submissions_read on public.submissions
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = submissions.session_id
        and public.is_team_member(s.team_id)
    )
  );

-- Writes happen only through the RPCs above, which perform the same checks and
-- additionally enforce the finalisation lock.
drop policy if exists submissions_write on public.submissions;
create policy submissions_write on public.submissions
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- submission_members --------------------------------------------------------
alter table public.submission_members enable row level security;

drop policy if exists submission_members_read on public.submission_members;
create policy submission_members_read on public.submission_members
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.submissions sub
      join public.build_sessions s on s.id = sub.session_id
      where sub.id = submission_members.submission_id
        and public.is_team_member(s.team_id)
    )
  );

-- A member may edit only their own contribution row.
drop policy if exists submission_members_write on public.submission_members;
create policy submission_members_write on public.submission_members
  for all
  using (public.is_admin() or user_id = auth.uid())
  with check (public.is_admin() or user_id = auth.uid());

-- submission_events ---------------------------------------------------------
alter table public.submission_events enable row level security;

drop policy if exists submission_events_read on public.submission_events;
create policy submission_events_read on public.submission_events
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.submissions sub
      join public.build_sessions s on s.id = sub.session_id
      where sub.id = submission_events.submission_id
        and public.is_team_member(s.team_id)
    )
  );
