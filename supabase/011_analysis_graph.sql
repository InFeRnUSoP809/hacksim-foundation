-- Evidence graph persistence and requirement statuses that describe
-- what was traced, not which technology was detected.
-- Idempotent.

alter table public.repositories
  add column if not exists analysis_stage text;

create table if not exists public.repository_symbols (
  id             uuid primary key default gen_random_uuid(),
  repository_id  uuid not null references public.repositories (id) on delete cascade,
  file_path      text not null,
  symbol         text not null,
  symbol_type    text not null,
  language       text,
  start_line     integer,
  end_line       integer,
  created_at     timestamptz not null default now()
);

create index if not exists repository_symbols_repo_idx
  on public.repository_symbols (repository_id);
create index if not exists repository_symbols_file_idx
  on public.repository_symbols (repository_id, file_path);

create table if not exists public.repository_relationships (
  id             uuid primary key default gen_random_uuid(),
  repository_id  uuid not null references public.repositories (id) on delete cascade,
  from_file      text not null,
  to_file        text not null,
  from_symbol    text,
  to_symbol      text,
  relation       text not null,
  line           integer,
  confidence     text,
  created_at     timestamptz not null default now()
);

create index if not exists repository_relationships_repo_idx
  on public.repository_relationships (repository_id);
create index if not exists repository_relationships_from_idx
  on public.repository_relationships (repository_id, from_file);

-- Widen requirement statuses. Old values stay valid so existing rows remain.
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.requirement_evaluations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%evidence_found%'
  loop
    execute format(
      'alter table public.requirement_evaluations drop constraint %I',
      r.conname
    );
  end loop;
end $$;

alter table public.requirement_evaluations
  add constraint requirement_evaluations_status_check
  check (status in (
    'confirmed',
    'partially_confirmed',
    'weakly_evidenced',
    'contradicted',
    'evidence_found',
    'partial_evidence',
    'not_evidenced',
    'unable_to_determine',
    'supported',
    'potential_concern',
    'partially_supported',
    'unclear'
  ));

alter table public.repository_symbols enable row level security;
alter table public.repository_relationships enable row level security;

drop policy if exists repository_symbols_read on public.repository_symbols;
create policy repository_symbols_read on public.repository_symbols
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.repositories repo
      join public.submissions sub on sub.id = repo.submission_id
      where repo.id = repository_id
        and public.owns_submission(sub.id)
    )
  );

drop policy if exists repository_relationships_read on public.repository_relationships;
create policy repository_relationships_read on public.repository_relationships
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.repositories repo
      join public.submissions sub on sub.id = repo.submission_id
      where repo.id = repository_id
        and public.owns_submission(sub.id)
    )
  );
