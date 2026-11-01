-- Cache and daily usage counters for the plant-autofill Edge Function.
-- Only the function (service role) reads and writes these tables; RLS blocks everyone else.
create table if not exists public.plant_autofill_cache (
  name_key text primary key,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.plant_autofill_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key (user_id, day)
);

alter table public.plant_autofill_cache enable row level security;
alter table public.plant_autofill_usage enable row level security;
