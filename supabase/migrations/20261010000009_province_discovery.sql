-- Province-based tender discovery, autonomous workflows on real tenders, and
-- the company profile the compliance and qualification agents check against.

-- ---------------------------------------------------------------------------
-- Settings: which provinces the Tender Scout watches
-- ---------------------------------------------------------------------------
create or replace function private.valid_provinces(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(x in ('EASTERN_CAPE', 'FREE_STATE', 'GAUTENG', 'KWAZULU_NATAL', 'LIMPOPO', 'MPUMALANGA',
                                 'NORTH_WEST', 'NORTHERN_CAPE', 'WESTERN_CAPE', 'NATIONAL')), true)
  from unnest(p) x;
$$;

alter table public.system_settings
  add column watched_provinces text[] not null default '{}' check (private.valid_provinces(watched_provinces)),
  add column auto_run_workflows boolean not null default true,
  add column max_auto_workflows_per_scan integer not null default 25 check (max_auto_workflows_per_scan between 0 and 500),
  add column last_discovery_at timestamptz;

-- ---------------------------------------------------------------------------
-- Tenders found by connectors
-- ---------------------------------------------------------------------------
alter table public.tenders
  add column source_ref text check (source_ref is null or char_length(source_ref) <= 120),
  add column documents jsonb not null default '[]'::jsonb check (jsonb_typeof(documents) = 'array');
create unique index tenders_source_ref_uq on public.tenders (organisation_id, source_id, source_ref)
  where source_ref is not null;

-- ---------------------------------------------------------------------------
-- Discovery runs (one per scan)
-- ---------------------------------------------------------------------------
create type public.discovery_status as enum ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

create table public.discovery_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  provinces text[] not null check (cardinality(provinces) > 0 and private.valid_provinces(provinces)),
  trigger text not null check (trigger in ('manual', 'schedule')),
  status public.discovery_status not null default 'QUEUED',
  source text not null default 'etenders',
  scanned integer not null default 0,
  matched integer not null default 0,
  created_tenders integer not null default 0,
  started_workflows integer not null default 0,
  error text,
  requested_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);
create index discovery_runs_org_idx on public.discovery_runs (organisation_id, created_at desc);
create unique index discovery_runs_active_uq on public.discovery_runs (organisation_id)
  where status in ('QUEUED', 'RUNNING');

alter table public.discovery_runs enable row level security;
create policy "members read discovery runs" on public.discovery_runs
  for select to authenticated using (private.is_org_member(organisation_id));
revoke all on public.discovery_runs from anon;
revoke insert, update, delete, truncate on public.discovery_runs from authenticated;

-- ---------------------------------------------------------------------------
-- Company profile (one per organisation)
-- ---------------------------------------------------------------------------
create table public.company_profiles (
  organisation_id uuid primary key references public.organisations (id) on delete cascade,
  legal_name text check (legal_name is null or char_length(legal_name) between 2 and 200),
  registration_number text check (registration_number is null or char_length(registration_number) <= 40),
  csd_number text check (csd_number is null or csd_number ~ '^MAAA[0-9]{7}$'),
  tax_pin text check (tax_pin is null or char_length(tax_pin) between 6 and 40),
  tax_pin_expires_at date,
  bbbee_level smallint check (bbbee_level is null or bbbee_level between 1 and 8),
  bbbee_expires_at date,
  cidb_grade text check (cidb_grade is null or cidb_grade ~ '^[1-9][A-Z]{1,3}$'),
  sectors text[] not null default '{}',
  provinces text[] not null default '{}' check (private.valid_provinces(provinces)),
  max_contract_value_zar numeric(16, 2) check (max_contract_value_zar is null or max_contract_value_zar > 0),
  authorised_signatory text check (authorised_signatory is null or char_length(authorised_signatory) between 2 and 120),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create trigger company_profiles_updated_at before update on public.company_profiles
  for each row execute function private.set_updated_at();

alter table public.company_profiles enable row level security;
create policy "members read company profile" on public.company_profiles
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "admins insert company profile" on public.company_profiles
  for insert to authenticated
  with check (private.has_org_role(organisation_id, array['owner', 'admin']::public.org_role[]));
create policy "admins update company profile" on public.company_profiles
  for update to authenticated
  using (private.has_org_role(organisation_id, array['owner', 'admin']::public.org_role[]))
  with check (private.has_org_role(organisation_id, array['owner', 'admin']::public.org_role[]));
revoke all on public.company_profiles from anon;
revoke delete, truncate on public.company_profiles from authenticated;

create or replace function private.audit_company_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.write_audit(new.organisation_id, 'company_profile.updated', 'company_profile', new.organisation_id::text,
    jsonb_build_object('fields', (select coalesce(jsonb_agg(k), '[]'::jsonb) from jsonb_object_keys(to_jsonb(new)) k
                                  where tg_op = 'INSERT' or to_jsonb(new) -> k is distinct from to_jsonb(old) -> k)));
  return null;
end;
$$;
create trigger company_profiles_audit after insert or update on public.company_profiles
  for each row execute function private.audit_company_profile();

-- ---------------------------------------------------------------------------
-- Workflows on real tenders
-- ---------------------------------------------------------------------------
-- Creates a run and enqueues it. Callers check permissions first.
create or replace function private.create_workflow_run(p_tender uuid, p_key text, p_options jsonb, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_s public.system_settings;
  v_run uuid;
  v_corr uuid := gen_random_uuid();
begin
  select * into v_t from public.tenders where id = p_tender for update;
  select * into v_s from public.system_settings where organisation_id = v_t.organisation_id;
  if v_s.kill_switch then
    raise exception 'The emergency kill switch is engaged; workflows cannot start' using errcode = 'check_violation';
  end if;
  if p_key not in ('simulated_bid', 'tender_bid') then
    raise exception 'Unknown workflow %', p_key using errcode = 'check_violation';
  end if;
  if p_key = 'simulated_bid' and not v_s.simulation_mode then
    raise exception 'Simulation workflows are disabled for this organisation' using errcode = 'check_violation';
  end if;
  if p_key = 'simulated_bid' and not v_t.is_simulation then
    raise exception 'The simulated workflow only runs on tenders marked as simulation tenders' using errcode = 'check_violation';
  end if;
  if p_key = 'tender_bid' and v_t.is_simulation then
    raise exception 'Simulation tenders use the simulated workflow' using errcode = 'check_violation';
  end if;
  p_options := coalesce(p_options, '{}'::jsonb);
  if jsonb_typeof(p_options) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_options) k where k not in ('fail_step', 'fail_times'))
     or (p_key <> 'simulated_bid' and p_options <> '{}'::jsonb)
     or (p_options ? 'fail_times' and (jsonb_typeof(p_options -> 'fail_times') <> 'number'
          or (p_options ->> 'fail_times')::int not between 1 and 10)) then
    raise exception 'Invalid workflow options' using errcode = 'check_violation';
  end if;
  if v_t.status <> 'DISCOVERED' then
    raise exception 'A workflow can only start from DISCOVERED (tender is %)', v_t.status using errcode = 'check_violation';
  end if;

  begin
    insert into public.workflow_runs (organisation_id, tender_id, workflow_key, status, is_simulation,
                                      options, correlation_id, max_tasks, started_by)
    values (v_t.organisation_id, v_t.id, p_key, 'PENDING', p_key = 'simulated_bid',
            p_options, v_corr, v_s.max_tasks_per_workflow, p_user)
    returning id into v_run;
  exception when unique_violation then
    raise exception 'A workflow is already active for this tender' using errcode = 'unique_violation';
  end;

  perform private.enqueue_job(v_t.organisation_id, 'workflow.start',
    jsonb_build_object('workflow_run_id', v_run), 'workflow.start:' || v_run);
  perform private.emit_event(v_t.organisation_id, 'WORKFLOW_REQUESTED',
    format('Workflow %s requested for "%s"', p_key, left(v_t.title, 200)),
    jsonb_build_object('workflow_key', p_key, 'automatic', p_user is null), 'INFO', null, v_t.id, null, v_run, null, null, v_corr);
  perform private.write_audit(v_t.organisation_id, 'workflow.requested', 'workflow_run', v_run::text,
    jsonb_build_object('tender_id', v_t.id, 'workflow_key', p_key, 'automatic', p_user is null), v_corr);
  return v_run;
end;
$$;

create or replace function public.start_tender_workflow(
  p_tender_id uuid, p_workflow_key text default null, p_options jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
begin
  select * into v_t from public.tenders where id = p_tender_id;
  if not found or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Tender not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  return private.create_workflow_run(p_tender_id,
    coalesce(p_workflow_key, case when v_t.is_simulation then 'simulated_bid' else 'tender_bid' end),
    p_options, auth.uid());
end;
$$;

-- ---------------------------------------------------------------------------
-- Discovery RPCs
-- ---------------------------------------------------------------------------
create or replace function public.set_watched_provinces(p_org uuid, p_provinces text[], p_auto_run boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can change watched provinces' using errcode = 'insufficient_privilege';
  end if;
  if not private.valid_provinces(coalesce(p_provinces, '{}')) then
    raise exception 'Unknown province' using errcode = 'check_violation';
  end if;
  update public.system_settings
     set watched_provinces = (select coalesce(array_agg(distinct x order by x), '{}') from unnest(p_provinces) x),
         auto_run_workflows = coalesce(p_auto_run, auto_run_workflows),
         updated_by = auth.uid()
   where organisation_id = p_org;
  perform private.write_audit(p_org, 'settings.watched_provinces', 'system_settings', p_org::text,
    jsonb_build_object('provinces', p_provinces, 'auto_run', p_auto_run));
end;
$$;

create or replace function private.queue_discovery(p_org uuid, p_provinces text[], p_trigger text, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if exists (select 1 from public.discovery_runs where organisation_id = p_org and status in ('QUEUED', 'RUNNING')) then
    select id into v_id from public.discovery_runs where organisation_id = p_org and status in ('QUEUED', 'RUNNING') limit 1;
    return v_id;
  end if;
  insert into public.discovery_runs (organisation_id, provinces, trigger, requested_by)
  values (p_org, p_provinces, p_trigger, p_user) returning id into v_id;
  perform private.enqueue_job(p_org, 'discovery.run', jsonb_build_object('discovery_run_id', v_id), 'discovery.run:' || v_id);
  perform private.emit_event(p_org, 'DISCOVERY_REQUESTED',
    format('Tender scan requested for %s', array_to_string(p_provinces, ', ')),
    jsonb_build_object('discovery_run_id', v_id, 'provinces', p_provinces, 'trigger', p_trigger));
  return v_id;
end;
$$;

create or replace function public.start_discovery(p_org uuid, p_provinces text[] default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.system_settings;
  v_p text[];
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('start_discovery', 6, 300);
  select * into v_s from public.system_settings where organisation_id = p_org;
  if v_s.kill_switch then
    raise exception 'The emergency kill switch is engaged; scans cannot start' using errcode = 'check_violation';
  end if;
  v_p := coalesce(p_provinces, v_s.watched_provinces);
  if cardinality(v_p) = 0 or v_p is null then
    raise exception 'Choose at least one province' using errcode = 'check_violation';
  end if;
  if not private.valid_provinces(v_p) then
    raise exception 'Unknown province' using errcode = 'check_violation';
  end if;
  return private.queue_discovery(p_org, v_p, 'manual', auth.uid());
end;
$$;

-- Daily scan of every organisation's watched provinces (called by pg_cron).
create or replace function private.queue_scheduled_discovery()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s record;
  v_n integer := 0;
begin
  for v_s in select organisation_id, watched_provinces from public.system_settings
              where cardinality(watched_provinces) > 0 and not kill_switch loop
    perform private.queue_discovery(v_s.organisation_id, v_s.watched_provinces, 'schedule', null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tenderos-daily-discovery', '0 4 * * *', 'select private.queue_scheduled_discovery()');
  end if;
end;
$$;

-- eTenders source row for existing and new organisations.
insert into public.tender_sources (organisation_id, slug, name, kind, base_url)
select id, 'etenders', 'National Treasury eTenders', 'API', 'https://www.etenders.gov.za'
from public.organisations
on conflict (organisation_id, slug) do nothing;

create or replace function private.add_etenders_source()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.tender_sources (organisation_id, slug, name, kind, base_url)
  values (new.id, 'etenders', 'National Treasury eTenders', 'API', 'https://www.etenders.gov.za')
  on conflict (organisation_id, slug) do nothing;
  return null;
end;
$$;
create trigger organisations_add_etenders after insert on public.organisations
  for each row execute function private.add_etenders_source();

alter publication supabase_realtime add table public.discovery_runs;

revoke all on function private.valid_provinces(text[]) from public;
revoke all on function private.create_workflow_run(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke all on function private.queue_discovery(uuid, text[], text, uuid) from public, anon, authenticated;
revoke all on function private.queue_scheduled_discovery() from public, anon, authenticated;
revoke all on function private.audit_company_profile() from public, anon, authenticated;
revoke all on function private.add_etenders_source() from public, anon, authenticated;
grant execute on function private.valid_provinces(text[]) to authenticated, service_role;
revoke execute on function public.start_tender_workflow(uuid, text, jsonb) from public, anon;
revoke execute on function public.set_watched_provinces(uuid, text[], boolean) from public, anon;
revoke execute on function public.start_discovery(uuid, text[]) from public, anon;
grant execute on function public.start_tender_workflow(uuid, text, jsonb) to authenticated;
grant execute on function public.set_watched_provinces(uuid, text[], boolean) to authenticated;
grant execute on function public.start_discovery(uuid, text[]) to authenticated;

-- When the company profile changes, runs that stopped at the compliance gate
-- are checked again, so filling in the profile resumes them automatically.
create or replace function private.recheck_blocked_compliance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run record;
  v_task uuid;
begin
  for v_run in select r.id, r.tender_id, r.correlation_id from public.workflow_runs r
                where r.organisation_id = new.organisation_id and r.status = 'BLOCKED' and r.current_step = 'compliance' loop
    select id into v_task from public.tasks
     where workflow_run_id = v_run.id and step_key = 'compliance' order by created_at desc limit 1;
    if v_task is null then continue; end if;
    update public.tasks set status = 'QUEUED', output = null, progress = 0, completed_at = null,
           progress_message = 'Re-checking with the updated company profile', blocked_reason = null
     where id = v_task;
    update public.workflow_runs set status = 'RUNNING', error = null where id = v_run.id;
    if (select status from public.tenders where id = v_run.tender_id) = 'MISSING_INFORMATION' then
      perform set_config('app.transition_reason', 'Company profile updated; compliance re-check', true);
      update public.tenders set status = 'COMPLIANCE_REVIEW' where id = v_run.tender_id;
    end if;
    perform private.enqueue_job(new.organisation_id, 'task.run', jsonb_build_object('task_id', v_task), 'task.run:' || v_task);
    perform private.emit_event(new.organisation_id, 'TASK_RETRY_REQUESTED',
      'Compliance re-check queued after the company profile changed', '{}'::jsonb, 'INFO',
      null, v_run.tender_id, v_task, v_run.id, null, null, v_run.correlation_id);
  end loop;
  return null;
end;
$$;
create trigger company_profiles_recheck after insert or update on public.company_profiles
  for each row execute function private.recheck_blocked_compliance();
revoke all on function private.recheck_blocked_compliance() from public, anon, authenticated;
