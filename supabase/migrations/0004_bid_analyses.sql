create table if not exists public.bid_analyses (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  division_code text,
  includes_count int default 0,
  excludes_count int default 0,
  allowances_count int default 0,
  alternates_count int default 0,
  summary jsonb,
  created_at timestamp with time zone default now()
);
alter table public.bid_analyses enable row level security;
drop policy if exists bid_analyses_owner_crud on public.bid_analyses;
create policy bid_analyses_owner_crud on public.bid_analyses
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
