-- Retention: delete what is no longer needed, on a schedule.
--
--   completed jobs                30 days
--   agent_events                  365 days  (the live activity stream; not the audit trail)
--   notifications                 90 days
--   audit_logs, cost_usage        system_settings.audit_retention_days, never less than 365; rows whose
--                                 organisation no longer exists (erased) keep the column default, 2555
--
-- cost_usage is kept for audit, so it follows the audit window rather than the short ones. Dead jobs are
-- kept for diagnosis until their organisation goes. The schedule is in docs/popia-operations.md.
--
-- Deleting from the append-only tables needs `app.erasure`, which this function sets for its own
-- transaction (see private.reject_mutation). Scheduled with pg_cron when it is installed; without it,
-- run `select private.run_retention_purge()` from any scheduler.

-- Purges filter on age alone, so give them cheap indexes (BRIN: tiny, and these tables are written in time order).
create index if not exists audit_logs_created_brin on public.audit_logs using brin (created_at);
create index if not exists agent_events_created_brin on public.agent_events using brin (created_at);
create index if not exists cost_usage_created_brin on public.cost_usage using brin (created_at);
create index if not exists notifications_created_brin on public.notifications using brin (created_at);
create index if not exists jobs_completed_idx on public.jobs (completed_at) where status = 'COMPLETED';

create or replace function private.run_retention_purge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_batch constant integer := 5000;
  c_max_batches constant integer := 200;
  c_audit_default constant integer := 2555;
  v_n integer;
  v_i integer;
  v_jobs integer := 0;
  v_events integer := 0;
  v_notes integer := 0;
  v_audit integer := 0;
  v_cost integer := 0;
  v_secrets integer := 0;
  v_result jsonb;
begin
  perform set_config('app.erasure', 'on', true);

  for v_i in 1..c_max_batches loop
    delete from public.jobs
     where id in (select j.id from public.jobs j where j.status = 'COMPLETED' and j.completed_at < now() - interval '30 days' limit c_batch);
    get diagnostics v_n = row_count;
    v_jobs := v_jobs + v_n;
    exit when v_n < c_batch;
  end loop;

  for v_i in 1..c_max_batches loop
    delete from public.agent_events
     where id in (select e.id from public.agent_events e where e.created_at < now() - interval '365 days' limit c_batch);
    get diagnostics v_n = row_count;
    v_events := v_events + v_n;
    exit when v_n < c_batch;
  end loop;

  for v_i in 1..c_max_batches loop
    delete from public.notifications
     where id in (select n.id from public.notifications n where n.created_at < now() - interval '90 days' limit c_batch);
    get diagnostics v_n = row_count;
    v_notes := v_notes + v_n;
    exit when v_n < c_batch;
  end loop;

  for v_i in 1..c_max_batches loop
    delete from public.audit_logs
     where id in (
       select a.id from public.audit_logs a
        where a.created_at < now() - interval '365 days'
          and a.created_at < now() - make_interval(days => greatest(365, coalesce(
                (select s.audit_retention_days from public.system_settings s where s.organisation_id = a.organisation_id), c_audit_default)))
        limit c_batch);
    get diagnostics v_n = row_count;
    v_audit := v_audit + v_n;
    exit when v_n < c_batch;
  end loop;

  for v_i in 1..c_max_batches loop
    delete from public.cost_usage
     where id in (
       select u.id from public.cost_usage u
        where u.created_at < now() - interval '365 days'
          and u.created_at < now() - make_interval(days => greatest(365, coalesce(
                (select s.audit_retention_days from public.system_settings s where s.organisation_id = u.organisation_id), c_audit_default)))
        limit c_batch);
    get diagnostics v_n = row_count;
    v_cost := v_cost + v_n;
    exit when v_n < c_batch;
  end loop;

  -- A mailbox credential no mailbox points at (left behind before email_accounts deleted its own secret).
  delete from vault.secrets s
   where s.name like 'tenderos\_email\_%' escape '\'
     and not exists (select 1 from public.email_accounts a where a.secret_id = s.id);
  get diagnostics v_secrets = row_count;

  v_result := jsonb_build_object('jobs', v_jobs, 'agent_events', v_events, 'notifications', v_notes, 'audit_logs', v_audit,
                                 'cost_usage', v_cost, 'mailbox_secrets', v_secrets);
  if v_jobs + v_events + v_notes + v_audit + v_cost + v_secrets > 0 then
    insert into public.audit_logs (organisation_id, actor_type, action, resource_type, metadata)
    values (null, 'system', 'retention.purged', 'retention', v_result);
  end if;
  return v_result;
end;
$$;
revoke all on function private.run_retention_purge() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tenderos-retention-purge', '30 3 * * *', 'select private.run_retention_purge()');
  end if;
end;
$$;
