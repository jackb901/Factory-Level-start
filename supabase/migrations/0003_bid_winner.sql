-- Winner flag per bid (per-division via bids.division_code)
alter table public.bids add column if not exists is_winner boolean default false;
