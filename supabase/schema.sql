-- HackSim — foundation schema
-- Run this once in the Supabase SQL Editor (Dashboard → SQL → New query).
-- It creates the minimum required for the first build: one `users` table
-- mirroring `auth.users`, with Row Level Security so a student can only ever
-- read and update their own row.

-- ─────────────────────────────────────────────────────────────
-- users
-- ─────────────────────────────────────────────────────────────
create table if not exists public.users (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text        not null,
  name       text,
  role       text        not null default 'student'
                         check (role in ('student', 'admin')),
  created_at timestamptz not null default now()
);

comment on table public.users is
  'HackSim user profile. One row per auth.users entry, created on signup.';

-- Email is the natural lookup key, so keep it unique and indexed.
create unique index if not exists users_email_key on public.users (email);

-- ─────────────────────────────────────────────────────────────
-- Auto-create the profile row when someone signs up
-- ─────────────────────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    'student'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────
-- Role helpers
-- ─────────────────────────────────────────────────────────────
-- Returns true when the caller has the admin role. Used by the admin-only
-- policies below. SECURITY DEFINER avoids a recursive RLS lookup on `users`.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ─────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────
alter table public.users enable row level security;

-- Students see only themselves; admins see everyone.
drop policy if exists "users_select_own_or_admin" on public.users;
create policy "users_select_own_or_admin"
  on public.users
  for select
  using (id = auth.uid() or public.is_admin());

-- A user may edit their own name, but can never change their own role:
-- with_role always re-reads the stored value, so the privilege can't escalate.
drop policy if exists "users_update_own" on public.users;
create policy "users_update_own"
  on public.users
  for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() and role = public.current_user_role());

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.users where id = auth.uid();
$$;

-- ─────────────────────────────────────────────────────────────
-- Promote your first admin
-- ─────────────────────────────────────────────────────────────
-- Everyone who signs up is a student. Run this after signing up, replacing the
-- email with your own. It must be run from the SQL Editor (service role), not
-- from the browser.
--
--   update public.users set role = 'admin' where email = 'you@example.com';
