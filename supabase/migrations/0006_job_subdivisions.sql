-- Custom sub-CSI divisions per job
create table if not exists public.job_subdivisions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  parent_code text not null references public.csi_divisions(code) on delete cascade,
  name text not null,
  created_at timestamp with time zone default now()
);

alter table public.job_subdivisions enable row level security;

drop policy if exists job_subdivisions_owner_all on public.job_subdivisions;
create policy job_subdivisions_owner_all on public.job_subdivisions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Link bids to optional subdivision
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bids' and column_name = 'subdivision_id'
  ) then
    alter table public.bids add column subdivision_id uuid null references public.job_subdivisions(id) on delete set null;
  end if;
end $$;
