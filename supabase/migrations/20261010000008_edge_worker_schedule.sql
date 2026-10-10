-- Hosted worker: a pg_cron job calls the `tenderos-worker` Edge Function every
-- minute. The function works through ready jobs for ~45 seconds per call.
--
-- Nothing is scheduled by this migration. On a hosted project, run once:
--   select vault.create_secret('<project url>', 'tenderos_project_url');
--   select vault.create_secret('<legacy anon JWT>', 'tenderos_function_jwt');
--   select private.schedule_edge_worker();
-- The worker secret is generated here and never leaves the database except
-- in the cron job's request header.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'tenderos_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'tenderos_worker_secret',
      'Shared secret between pg_cron and the tenderos-worker Edge Function');
  end if;
end;
$$;

create or replace function private.call_edge_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'tenderos_project_url');
  v_jwt text := (select decrypted_secret from vault.decrypted_secrets where name = 'tenderos_function_jwt');
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'tenderos_worker_secret');
begin
  if v_url is null or v_jwt is null or v_secret is null then
    raise exception 'Edge worker secrets are not configured in Vault';
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/tenderos-worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_jwt, 'x-worker-secret', v_secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

create or replace function private.schedule_edge_worker()
returns bigint
language sql
security definer
set search_path = ''
as $$
  select cron.schedule('tenderos-edge-worker', '* * * * *', 'select private.call_edge_worker()');
$$;

revoke all on function private.call_edge_worker() from public;
revoke all on function private.schedule_edge_worker() from public;
