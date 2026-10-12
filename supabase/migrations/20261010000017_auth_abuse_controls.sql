-- Abuse controls for sign-in, sign-up and password reset (docs/auth.md).
--
-- The app limits these unauthenticated actions per visitor address and per
-- email through public.hit_rate_limit_key (migration 015), which only the
-- service role may call. Subjects are HMACs (`auth_ip:<hex64>`,
-- `auth_email:<hex64>`), never raw addresses or emails. Each distinct subject
-- and action leaves one row in private.rate_limits, and nothing ever removed
-- rows, so this adds the sweeper.

-- Windows are capped at 3600 seconds, so a row whose window started more than
-- a day ago can never count against anyone again.
create index rate_limits_window_idx on private.rate_limits (window_start);

create or replace function private.sweep_rate_limits()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.rate_limits where window_start < now() - interval '1 day';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function private.sweep_rate_limits() from public, anon, authenticated;

-- pg_cron is present on Supabase projects (migrations 008 and 014 use it); the
-- guard keeps this migration usable on a database without it, where the
-- sweeper can be run by hand.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tenderos-sweep-rate-limits', '17 * * * *', 'select private.sweep_rate_limits()');
  end if;
end;
$$;
