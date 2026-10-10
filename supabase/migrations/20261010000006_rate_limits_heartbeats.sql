-- Rate limiting for user-initiated actions and worker heartbeats.

create table private.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);

-- Fixed-window limiter. Raises when the caller exceeds p_max actions per window.
create or replace function private.check_rate_limit(p_key text, p_max integer, p_window interval)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into private.rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update
    set count = case when r.window_start < now() - p_window then 1 else r.count + 1 end,
        window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning count into v_count;
  if v_count > p_max then
    raise exception 'Too many requests; please wait and try again' using errcode = 'P0429';
  end if;
end;
$$;
revoke all on function private.check_rate_limit(text, integer, interval) from public, anon, authenticated;

-- Server actions call this before doing work. The key is always bound to the caller.
create or replace function public.hit_rate_limit(p_action text, p_max integer default 30, p_window_seconds integer default 60)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  if p_action !~ '^[a-z][a-z0-9_.]{2,60}$' or p_max not between 1 and 1000 or p_window_seconds not between 1 and 3600 then
    raise exception 'Invalid rate limit request' using errcode = 'check_violation';
  end if;
  perform private.check_rate_limit(auth.uid()::text || ':' || p_action, p_max, make_interval(secs => p_window_seconds));
end;
$$;
revoke execute on function public.hit_rate_limit(text, integer, integer) from public, anon;
grant execute on function public.hit_rate_limit(text, integer, integer) to authenticated;

-- Worker heartbeats: lets the command centre show whether background agents are actually running.
create table public.worker_heartbeats (
  worker_id text primary key check (char_length(worker_id) <= 64),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  in_flight integer not null default 0,
  processed integer not null default 0,
  version text
);
alter table public.worker_heartbeats enable row level security;
create policy "authenticated read heartbeats" on public.worker_heartbeats
  for select to authenticated using (true);
revoke all on public.worker_heartbeats from anon;
revoke insert, update, delete, truncate on public.worker_heartbeats from authenticated;
