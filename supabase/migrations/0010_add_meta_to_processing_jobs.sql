-- Add meta column to processing_jobs to carry job parameters (division, subdivisionId, etc.)
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'processing_jobs' and column_name = 'meta'
  ) then
    alter table public.processing_jobs add column meta jsonb default '{}'::jsonb;
  end if;
end $$;
