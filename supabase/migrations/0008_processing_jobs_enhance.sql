-- Enhance processing_jobs for queued batching
do $$ begin
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='status'
  ) then
    alter table public.processing_jobs add column status text default 'queued';
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='progress'
  ) then
    alter table public.processing_jobs add column progress int default 0;
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='error'
  ) then
    alter table public.processing_jobs add column error text;
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='batches_total'
  ) then
    alter table public.processing_jobs add column batches_total int;
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='batches_done'
  ) then
    alter table public.processing_jobs add column batches_done int;
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='token_estimate'
  ) then
    alter table public.processing_jobs add column token_estimate int;
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='token_actual'
  ) then
    alter table public.processing_jobs add column token_actual int;
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='started_at'
  ) then
    alter table public.processing_jobs add column started_at timestamptz;
  end if;
  if not exists (
    select 1 from information_schema.columns where table_schema='public' and table_name='processing_jobs' and column_name='finished_at'
  ) then
    alter table public.processing_jobs add column finished_at timestamptz;
  end if;
end $$;
