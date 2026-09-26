-- ============================================================================
-- 002 — hackathons, teams, build sessions, checkpoints
-- ============================================================================
-- Phase 2 + Phase 3. Run after 001_profiles.sql.
--
-- Every "the backend must verify" rule in the product spec is enforced HERE,
-- in Postgres. The browser only ever holds the anon key, so the database is
-- the only place a rule can actually be trusted — hiding a button in React is
-- never sufficient.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- Helpers
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.is_team_member(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.team_members m
    where m.team_id = p_team_id and m.user_id = auth.uid()
  );
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- hackathons — the single source of truth for the challenge
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.hackathons (
  id                           uuid primary key default gen_random_uuid(),
  name                         text        not null check (length(trim(name)) between 2 and 120),
  problem_statement            text        not null,
  requirements                 text,
  constraints                  text,
  expected_outcome             text,
  evaluation_criteria          text,
  simulation_duration_minutes  integer     not null
                                           check (simulation_duration_minutes between 1 and 10080),
  status                       text        not null default 'draft'
                                           check (status in ('draft', 'active', 'archived')),
  practice_enabled             boolean     not null default false,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);

comment on table public.hackathons is
  'The practice hackathon challenge. The app never hardcodes a problem statement.';

create index if not exists hackathons_practice_idx on public.hackathons (practice_enabled);
create index if not exists hackathons_status_idx   on public.hackathons (status);

-- BUSINESS RULE 1 — at most one practice hackathon may exist. This holds even
-- if the admin UI is bypassed or double-clicked.
create unique index if not exists hackathons_single_practice
  on public.hackathons ((practice_enabled))
  where practice_enabled = true;

drop trigger if exists hackathons_touch on public.hackathons;
create trigger hackathons_touch
  before update on public.hackathons
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- teams + team_members
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.teams (
  id         uuid primary key default gen_random_uuid(),
  name       text        not null check (length(trim(name)) between 2 and 60),
  created_by uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists teams_created_by_idx on public.teams (created_by);

-- `role` is free text on purpose. A member may contribute across many areas,
-- so it is not constrained to frontend/backend style values.
create table if not exists public.team_members (
  id         uuid primary key default gen_random_uuid(),
  team_id    uuid        not null references public.teams (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  role       text        not null default 'Other',
  joined_at  timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A student cannot be added to the same team twice.
  unique (team_id, user_id)
);

create index if not exists team_members_team_idx on public.team_members (team_id);
create index if not exists team_members_user_idx on public.team_members (user_id);

-- One team per student, which keeps "does this student already have a run?"
-- unambiguous. Join a second team only after leaving the first.
create unique index if not exists team_members_one_team_per_user
  on public.team_members (user_id);

drop trigger if exists team_members_touch on public.team_members;
create trigger team_members_touch
  before update on public.team_members
  for each row execute function public.touch_updated_at();

drop trigger if exists teams_touch on public.teams;
create trigger teams_touch
  before update on public.teams
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- build_sessions
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.build_sessions (
  id            uuid primary key default gen_random_uuid(),
  hackathon_id  uuid        not null references public.hackathons (id) on delete restrict,
  team_id       uuid        not null references public.teams (id) on delete cascade,
  started_by    uuid        not null references public.profiles (id) on delete cascade,
  started_at    timestamptz not null default now(),
  ends_at       timestamptz not null,
  break_ends_at timestamptz,
  status        text        not null default 'not_started'
                          check (status in ('not_started', 'running', 'break',
                                            'completed', 'expired', 'submitted')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- BUSINESS RULE 4/5 — `ends_at` is computed once, at insert, from the duration
-- that was configured *at that moment*. Editing the hackathon later can never
-- reach in and move an existing session's deadline.
create index if not exists build_sessions_hackathon_idx on public.build_sessions (hackathon_id);
create index if not exists build_sessions_team_idx      on public.build_sessions (team_id);
create index if not exists build_sessions_started_by_idx on public.build_sessions (started_by);
create index if not exists build_sessions_status_idx    on public.build_sessions (status);
create index if not exists build_sessions_ends_at_idx   on public.build_sessions (ends_at);

drop trigger if exists build_sessions_touch on public.build_sessions;
create trigger build_sessions_touch
  before update on public.build_sessions
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- build_checkpoints
-- ────────────────────────────────────────────────────────────────────────────
-- `checkpoint_type` is a CHECK rather than an enum type, so later phases can
-- add checkpoint kinds without a type migration.
create table if not exists public.build_checkpoints (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid        not null references public.build_sessions (id) on delete cascade,
  checkpoint_type text        not null check (checkpoint_type in
                        ('planning', 'building', 'progress',
                         'remaining_work', 'final_preparation')),
  response        text        not null default '',
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (session_id, checkpoint_type)
);

create index if not exists build_checkpoints_session_idx on public.build_checkpoints (session_id);

drop trigger if exists build_checkpoints_touch on public.build_checkpoints;
create trigger build_checkpoints_touch
  before update on public.build_checkpoints
  for each row execute function public.touch_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- Team RPCs
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.create_team(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a team.';
  end if;

  if exists (select 1 from public.team_members where user_id = auth.uid()) then
    raise exception 'You already belong to a team. Leave it first to start a new one.';
  end if;

  insert into public.teams (name, created_by)
  values (trim(p_name), auth.uid())
  returning id into v_team_id;

  insert into public.team_members (team_id, user_id, role)
  values (v_team_id, auth.uid(), 'Other');

  return v_team_id;
end;
$$;

-- Invite by email. SECURITY DEFINER lets us resolve the address from
-- auth.users without ever exposing a browsable user directory to the client.
create or replace function public.add_team_member(p_team_id uuid, p_email text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_member  uuid;
begin
  if not public.is_team_member(p_team_id) and not public.is_admin() then
    raise exception 'Only members of a team can add people to it.';
  end if;

  select p.id into v_user_id
  from public.profiles p
  where lower(p.email) = lower(trim(p_email))
  limit 1;

  if v_user_id is null then
    raise exception 'No HackSim account uses that email address.';
  end if;

  if v_user_id = auth.uid() then
    raise exception 'You are already a member of this team.';
  end if;

  if exists (select 1 from public.team_members where user_id = v_user_id) then
    raise exception 'That person is already in a team.';
  end if;

  insert into public.team_members (team_id, user_id, role)
  values (p_team_id, v_user_id, 'Other')
  returning id into v_member;

  return v_member;
end;
$$;

create or replace function public.leave_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_team_member(p_team_id) and not public.is_admin() then
    raise exception 'You are not a member of that team.';
  end if;

  delete from public.team_members
  where team_id = p_team_id and user_id = auth.uid();

  if not exists (select 1 from public.team_members where team_id = p_team_id) then
    delete from public.teams where id = p_team_id;
  end if;
end;
$$;

-- The roster for one team. SECURITY DEFINER is required: teammates must see
-- each other's names, but a profile row is otherwise only visible to its owner.
create or replace function public.team_roster(p_team_id uuid)
returns table (
  member_id uuid,
  user_id   uuid,
  full_name text,
  email     text,
  role      text,
  joined_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.user_id, p.full_name, p.email, m.role, m.joined_at
  from public.team_members m
  join public.profiles p on p.id = m.user_id
  where m.team_id = p_team_id
    and (public.is_team_member(p_team_id) or public.is_admin())
  order by m.joined_at;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Practice hackathon control (admin only)
-- ────────────────────────────────────────────────────────────────────────────
-- Turns practice on for exactly one hackathon and off for every other.
-- Nothing is deleted, so historical sessions keep pointing at the hackathon
-- they were started against. Pass null to switch practice off entirely.
create or replace function public.set_practice_hackathon(p_hackathon_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only an administrator can change practice mode.';
  end if;

  if p_hackathon_id is not null and not exists (
    select 1 from public.hackathons where id = p_hackathon_id
  ) then
    raise exception 'That hackathon does not exist.';
  end if;

  -- Turn the others off first so the partial unique index never trips.
  update public.hackathons
     set practice_enabled = false
   where practice_enabled = true
     and (p_hackathon_id is null or id <> p_hackathon_id);

  if p_hackathon_id is not null then
    update public.hackathons
       set practice_enabled = true
     where id = p_hackathon_id;
  end if;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Starting a simulation
-- ────────────────────────────────────────────────────────────────────────────
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
begin
  -- 1. authenticated
  if auth.uid() is null then
    raise exception 'You must be signed in to start a simulation.';
  end if;

  -- 2. belongs to a valid team
  select tm.team_id into v_team_id
  from public.team_members tm
  where tm.user_id = auth.uid()
  limit 1;

  if v_team_id is null then
    raise exception 'Create or join a team before starting a simulation.';
  end if;

  -- 3/4. hackathon valid, 5. practice currently enabled
  select simulation_duration_minutes, practice_enabled, status
    into v_duration, v_enabled, v_status
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

  -- 6. no conflicting live run for this team
  select id into v_existing
  from public.build_sessions
  where team_id = v_team_id
    and status in ('running', 'break')
  limit 1;

  if v_existing is not null then
    raise exception 'Your team already has a simulation in progress.';
  end if;

  -- Timestamps come from the database, never from the client.
  insert into public.build_sessions
    (hackathon_id, team_id, started_by, started_at, ends_at, status)
  values
    (p_hackathon_id, v_team_id, auth.uid(), now(),
     now() + make_interval(mins => v_duration), 'running')
  returning id into v_new;

  return v_new;
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Authoritative clock
-- ────────────────────────────────────────────────────────────────────────────
-- Remaining time is computed from now() in Postgres. A changed device clock
-- therefore cannot extend a simulation, and a refresh cannot reset it.
--
-- This also self-heals time-based transitions: an elapsed build becomes
-- 'expired' and an elapsed break resumes to 'running'. That keeps the stored
-- status honest without needing a background worker.
create or replace function public.session_state(p_session_id uuid)
returns table (
  status                  text,
  remaining_seconds       bigint,
  break_remaining_seconds bigint,
  server_now              timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.build_sessions;
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  if s.status = 'running' and s.ends_at <= now() then
    update public.build_sessions
       set status = 'expired', break_ends_at = null
     where id = s.id;
    s.status := 'expired';
  end if;

  if s.status = 'break' and s.break_ends_at is not null
     and s.break_ends_at <= now() then
    update public.build_sessions
       set status = 'running', break_ends_at = null
     where id = s.id;
    s.status := 'running';
  end if;

  return query
  select
    s.status::text,
    greatest(0, floor(extract(epoch from (s.ends_at - now()))))::bigint,
    case
      when s.status = 'break' and s.break_ends_at is not null
        then greatest(0, floor(extract(epoch from (s.break_ends_at - now()))))::bigint
      else 0
    end,
    now();
end;
$$;

-- A run keeps its brief even if the admin later switches practice off.
-- BUSINESS RULE 3 — turning practice off must not blind anyone mid-run.
create or replace function public.hackathon_for_session(p_session_id uuid)
returns setof public.hackathons
language sql
stable
security definer
set search_path = public
as $$
  select h.*
  from public.hackathons h
  join public.build_sessions s on s.hackathon_id = h.id
  where s.id = p_session_id
    and (public.is_team_member(s.team_id) or public.is_admin());
$$;

-- Deliberately narrow: a student may only move a live run into break, back to
-- running, or to completed. Nothing here can move ends_at.
create or replace function public.set_session_status(
  p_session_id    uuid,
  p_status        text,
  p_break_minutes integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.build_sessions;
  v_break integer := coalesce(p_break_minutes, 10);
begin
  select * into s from public.build_sessions where id = p_session_id;

  if s.id is null then
    raise exception 'Simulation not found.';
  end if;

  if not (public.is_team_member(s.team_id) or public.is_admin()) then
    raise exception 'You are not authorized to perform this action.';
  end if;

  if s.status in ('completed', 'expired', 'submitted') then
    raise exception 'This simulation has already finished.';
  end if;

  if s.ends_at <= now() then
    raise exception 'Simulation has expired.';
  end if;

  if p_status = 'break' and s.status = 'running' then
    update public.build_sessions
       set status = 'break',
           break_ends_at = now() + make_interval(mins => v_break)
     where id = s.id;
    return;
  end if;

  if p_status = 'running' and s.status = 'break' then
    update public.build_sessions
       set status = 'running', break_ends_at = null
     where id = s.id;
    return;
  end if;

  if p_status = 'completed' and s.status in ('running', 'break') then
    update public.build_sessions
       set status = 'completed', break_ends_at = null
     where id = s.id;
    return;
  end if;

  raise exception 'That status change is not allowed.';
end;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Admin reporting
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.admin_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'users',              (select count(*) from public.profiles),
    'teams',              (select count(*) from public.teams),
    'active_sessions',    (select count(*) from public.build_sessions
                            where status in ('running', 'break')),
    'completed_sessions', (select count(*) from public.build_sessions
                            where status in ('completed', 'expired', 'submitted')),
    'submissions',        (select count(*) from public.submissions)
  );
$$;

create or replace function public.admin_teams()
returns table (
  id           uuid,
  name         text,
  created_by   uuid,
  created_at   timestamptz,
  member_count bigint,
  live_status  text,
  session_id   uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select t.id, t.name, t.created_by, t.created_at,
         (select count(*) from public.team_members m where m.team_id = t.id),
         coalesce((
           select s.status::text from public.build_sessions s
           where s.team_id = t.id
           order by s.created_at desc limit 1
         ), 'not_started'),
         (
           select s.id from public.build_sessions s
           where s.team_id = t.id
           order by s.created_at desc limit 1
         )
  from public.teams t
  where public.is_admin()
  order by t.created_at desc;
$$;

create or replace function public.admin_sessions()
returns table (
  id              uuid,
  team_id         uuid,
  team_name       text,
  hackathon_id    uuid,
  hackathon_name  text,
  started_by      uuid,
  started_by_name text,
  started_at      timestamptz,
  ends_at         timestamptz,
  status          text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.team_id, t.name, s.hackathon_id, h.name,
         s.started_by, coalesce(p.full_name, p.email, 'Unknown'),
         s.started_at, s.ends_at, s.status::text
  from public.build_sessions s
  join public.teams t       on t.id = s.team_id
  join public.hackathons h on h.id = s.hackathon_id
  left join public.profiles p on p.id = s.started_by
  where public.is_admin()
  order by s.created_at desc;
$$;


-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ────────────────────────────────────────────────────────────────────────────

-- hackathons ----------------------------------------------------------------
alter table public.hackathons enable row level security;

drop policy if exists hackathons_read on public.hackathons;
create policy hackathons_read on public.hackathons
  for select
  using (
    public.is_admin()
    -- A student reads exactly one row: the live practice hackathon. When
    -- practice is off this matches nothing, so the brief is genuinely
    -- unreachable rather than merely hidden.
    or (practice_enabled = true and status = 'active')
  );

drop policy if exists hackathons_write on public.hackathons;
create policy hackathons_write on public.hackathons
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- teams ---------------------------------------------------------------------
alter table public.teams enable row level security;

drop policy if exists teams_read on public.teams;
create policy teams_read on public.teams
  for select
  using (public.is_admin() or public.is_team_member(id));

drop policy if exists teams_write on public.teams;
create policy teams_write on public.teams
  for all
  using (public.is_admin() or created_by = auth.uid())
  with check (public.is_admin() or created_by = auth.uid());

-- team_members --------------------------------------------------------------
alter table public.team_members enable row level security;

drop policy if exists team_members_read on public.team_members;
create policy team_members_read on public.team_members
  for select
  using (public.is_admin() or public.is_team_member(team_id));

drop policy if exists team_members_write on public.team_members;
create policy team_members_write on public.team_members
  for all
  using (public.is_admin() or public.is_team_member(team_id))
  with check (public.is_admin() or public.is_team_member(team_id));

-- build_sessions ------------------------------------------------------------
-- Students get read-only access. There is deliberately no INSERT or UPDATE
-- policy, so a student cannot hand-edit ends_at to buy more time. Every write
-- goes through the RPCs above.
alter table public.build_sessions enable row level security;

drop policy if exists build_sessions_read on public.build_sessions;
create policy build_sessions_read on public.build_sessions
  for select
  using (public.is_admin() or public.is_team_member(team_id));

-- build_checkpoints --------------------------------------------------------
alter table public.build_checkpoints enable row level security;

drop policy if exists build_checkpoints_read on public.build_checkpoints;
create policy build_checkpoints_read on public.build_checkpoints
  for select
  using (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and public.is_team_member(s.team_id)
    )
  );

-- Writes require the session to be genuinely running. Once the database has
-- marked it expired this stops matching and the row is frozen — no client-side
-- check is relied upon.
drop policy if exists build_checkpoints_write on public.build_checkpoints;
create policy build_checkpoints_write on public.build_checkpoints
  for all
  using (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and s.status = 'running'
        and public.is_team_member(s.team_id)
    )
  )
  with check (
    public.is_admin() or exists (
      select 1 from public.build_sessions s
      where s.id = build_checkpoints.session_id
        and s.status = 'running'
        and public.is_team_member(s.team_id)
    )
  );
