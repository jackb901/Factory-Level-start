-- Cache for per-document extraction results
create table if not exists public.document_extractions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete cascade,
  bid_id uuid references public.bids(id) on delete cascade,
  storage_path text not null,
  sha256 text not null,
  result jsonb not null,
  created_at timestamptz default now()
);

create unique index if not exists document_extractions_sha256_idx on public.document_extractions(sha256);

alter table public.document_extractions enable row level security;
drop policy if exists document_extractions_owner_all on public.document_extractions;
create policy document_extractions_owner_all on public.document_extractions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
