-- ────────────────────────────────────────────────────────────────────────────
-- 009_my_sessions.sql
--
-- The student's own participation history: every hackathon they have run, with
-- the team's name, the submission's state and whether a review exists.
--
-- Why a function and not a client-side join:
--   `build_sessions` is readable by a student's team (002's
--   `build_sessions_read`), but `hackathons` is deliberately NOT — a student may
--   read exactly one row there, the live practice hackathon. So a PostgREST
--   select from build_sessions joined to hackathons returns sessions with a
--   null name, and the history is the one screen that is useless without the
--   name. The join has to happen on this side of the RLS boundary.
--
-- `hackathon_for_session` solves the same problem for exactly one session; this
-- is the list-shaped version of it.
--
-- SECURITY DEFINER for the join only. The `is_team_member` predicate below is
-- the real access control and it runs as the caller, so a student still sees
-- only the sessions of teams they belong to — no admin bypass, because a
-- student's own history is not an admin's business.
--
-- Idempotent: safe to re-run.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.my_sessions()
returns table (
  id                uuid,
  hackathon_id      uuid,
  hackathon_name    text,
  team_id           uuid,
  team_name         text,
  started_at        timestamptz,
  ends_at           timestamptz,
  status            text,
  submission_id     uuid,
  submission_status text,
  github_url        text,
  review_status     text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.hackathon_id,
    h.name,
    s.team_id,
    t.name,
    s.started_at,
    s.ends_at,
    s.status::text,
    sub.id,
    sub.status::text,
    sub.github_url,
    (
      select pr.status::text
        from public.project_reviews pr
       where pr.submission_id = sub.id
       order by pr.created_at desc
       limit 1
    )
  from public.build_sessions s
  join public.hackathons h on h.id = s.hackathon_id
  join public.teams t on t.id = s.team_id
  left join public.submissions sub on sub.session_id = s.id
  where public.is_team_member(s.team_id)
  order by coalesce(s.started_at, s.created_at) desc;
$$;

comment on function public.my_sessions() is
  'The signed-in student''s own participation history, newest first. Team members only; no admin bypass.';
