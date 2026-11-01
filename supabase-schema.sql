create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

drop policy if exists "Users can read their own garden data" on public.user_data;
create policy "Users can read their own garden data"
  on public.user_data for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own garden data" on public.user_data;
create policy "Users can insert their own garden data"
  on public.user_data for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own garden data" on public.user_data;
create policy "Users can update their own garden data"
  on public.user_data for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on public.user_data to authenticated;

create or replace function public.save_user_data(
  p_data jsonb,
  p_expected_revision bigint
)
returns table (revision bigint, updated_at timestamptz)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.';
  end if;

  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Garden data must be a JSON object.';
  end if;

  return query
  insert into public.user_data as current_data (user_id, data, revision, updated_at)
  values (auth.uid(), p_data, 1, now())
  on conflict (user_id) do update
    set data = excluded.data,
        revision = current_data.revision + 1,
        updated_at = now()
    where p_expected_revision is not null
      and current_data.revision = p_expected_revision
  returning current_data.revision, current_data.updated_at;
end;
$$;

revoke all on function public.save_user_data(jsonb, bigint) from public, anon;
grant execute on function public.save_user_data(jsonb, bigint) to authenticated;
