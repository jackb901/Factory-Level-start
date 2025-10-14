-- Add subdivision_id to bid_level_reports to support sub-CSI division reports
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bid_level_reports' and column_name = 'subdivision_id'
  ) then
    alter table public.bid_level_reports add column subdivision_id uuid null references public.job_subdivisions(id) on delete set null;
  end if;
end $$;
