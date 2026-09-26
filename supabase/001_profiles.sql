-- ============================================================================
-- 001 — profiles
-- ============================================================================
-- HackSim's mirror of `auth.users`. One row per registered account, created
-- automatically on signup. Authentication itself is handled entirely by
-- Supabase Auth; no credential is ever stored here.
--
-- Run order: 001 → 002 → 003 → (optional) seed.sql
-- Every file is idempotent, so re-running is safe.
-- ============================================================================

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  email      text        not null,
  role       text        not null default 'student'
                         check (role in ('student', 'admin')),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Application profile for each auth.users account. Never stores credentials.';

create index if not exists profiles_role_idx  on public.profiles (role);
create index if not exists profiles_email_idx on public.profiles (email);

-- ── Shared helpers ──────────────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- SECURITY DEFINER so an RLS check on profiles cannot recurse into itself.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ── Signup trigger ──────────────────────────────────────────────────────────
-- A profile is created for every new auth user, always with role = 'student'.
-- The role is never taken from client input, so nobody can self-promote to
-- admin during signup.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
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

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- ── Row Level Security ──────────────────────────────────────────────────────
-- A user reads and edits their own row. Admins read and edit all rows.
-- `role` is protected by a trigger below so nobody can escalate their own
-- privilege through the generic update policy.

alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select
  using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles
  for insert
  with check (id = auth.uid() and role = 'student');

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- Strip any attempt to change a role or an id through a normal profile update.
create or replace function public.protect_profile_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.id <> old.id then
      new.id = old.id;
    end if;
    if new.role <> old.role then
      new.role = old.role;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect
  before update on public.profiles
  for each row execute function public.protect_profile_columns();


-- ── Promote an admin ───────────────────────────────────────────────────────
-- There is deliberately no self-service path to the admin role. Run this from
-- the Supabase SQL Editor, which uses the service role, never from the browser:
--
--   update public.profiles set role = 'admin' where email = 'you@example.com';
-- ============================================================================
