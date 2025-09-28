-- Enable required extensions
-- Use Supabase extensions schema; ensure functions are resolvable
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

-- Basic user profile (one-tenant-per-user for MVP)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  created_at timestamp with time zone default now()
);
alter table public.profiles enable row level security;
create policy "profiles_self_access" on public.profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

-- Jobs owned by a user (MVP: single-user tenant)
create table if not exists public.jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  status text default 'draft',
  created_at timestamp with time zone default now()
);
alter table public.jobs enable row level security;
create policy "jobs_owner_crud" on public.jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Contractors linked to a job
create table if not exists public.contractors (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamp with time zone default now()
);
alter table public.contractors enable row level security;
create policy "contractors_owner_crud" on public.contractors
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Bids per contractor
create table if not exists public.bids (
  id uuid primary key default extensions.gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  contractor_id uuid references public.contractors(id) on delete set null,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text default 'uploaded',
  total numeric,
  created_at timestamp with time zone default now()
);
alter table public.bids enable row level security;
create policy "bids_owner_crud" on public.bids
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Documents attached to a bid
create table if not exists public.documents (
  id uuid primary key default extensions.gen_random_uuid(),
  bid_id uuid not null references public.bids(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  file_type text not null,
  storage_path text not null,
  ocr_required boolean default false,
  created_at timestamp with time zone default now()
);
alter table public.documents enable row level security;
create policy "documents_owner_crud" on public.documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Categories and line items (simplified for MVP)
create table if not exists public.categories (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  name text not null,
  parent_id uuid references public.categories(id) on delete cascade,
  created_at timestamp with time zone default now()
);
alter table public.categories enable row level security;
create policy "categories_owner_crud" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.line_items (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bid_id uuid not null references public.bids(id) on delete cascade,
  category_id uuid references public.categories(id) on delete set null,
  raw_text text,
  canonical_name text,
  qty numeric,
  unit text,
  unit_cost numeric,
  total numeric,
  confidence numeric,
  created_at timestamp with time zone default now()
);
alter table public.line_items enable row level security;
create policy "line_items_owner_crud" on public.line_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Processing jobs (pipeline status)
create table if not exists public.processing_jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null references public.jobs(id) on delete cascade,
  stage text,
  state text,
  progress int,
  created_at timestamp with time zone default now()
);
alter table public.processing_jobs enable row level security;
create policy "processing_jobs_owner_crud" on public.processing_jobs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Feedback (learning signals)
create table if not exists public.feedback (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  context text,
  from_value text,
  to_value text,
  created_at timestamp with time zone default now()
);
alter table public.feedback enable row level security;
create policy "feedback_owner_crud" on public.feedback
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Create private storage bucket for bids
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'bids') then
    perform storage.create_bucket(id => 'bids', name => 'bids', public => false);
  end if;
end $$;

-- Storage policies: allow users to access only their own paths under users/{uid}/...
drop policy if exists "storage_bids_read_own" on storage.objects;
create policy "storage_bids_read_own" on storage.objects
  for select using (
    bucket_id = 'bids' and name like ('users/' || auth.uid()::text || '/%')
  );

drop policy if exists "storage_bids_write_own" on storage.objects;
create policy "storage_bids_write_own" on storage.objects
  for insert with check (
    bucket_id = 'bids' and name like ('users/' || auth.uid()::text || '/%')
  );

drop policy if exists "storage_bids_update_own" on storage.objects;
create policy "storage_bids_update_own" on storage.objects
  for update using (
    bucket_id = 'bids' and name like ('users/' || auth.uid()::text || '/%')
  ) with check (
    bucket_id = 'bids' and name like ('users/' || auth.uid()::text || '/%')
  );

drop policy if exists "storage_bids_delete_own" on storage.objects;
create policy "storage_bids_delete_own" on storage.objects
  for delete using (
    bucket_id = 'bids' and name like ('users/' || auth.uid()::text || '/%')
  );
