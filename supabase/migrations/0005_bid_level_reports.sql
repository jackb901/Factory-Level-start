create table if not exists public.bid_level_reports (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  division_code text,
  report jsonb not null,
  created_at timestamp with time zone default now()
);
alter table public.bid_level_reports enable row level security;
drop policy if exists bid_level_reports_owner_crud on public.bid_level_reports;
create policy bid_level_reports_owner_crud on public.bid_level_reports
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
