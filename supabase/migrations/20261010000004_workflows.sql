-- Durable workflow layer: workflow runs, tasks, handoffs, the Postgres job
-- queue, approvals, submissions, notifications and cost tracking.

create type public.workflow_run_status as enum (
  'PENDING', 'RUNNING', 'WAITING_APPROVAL', 'BLOCKED', 'COMPLETED', 'FAILED', 'CANCELLED'
);
create type public.task_status as enum (
  'QUEUED', 'RUNNING', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'
);
create type public.handoff_status as enum ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');
create type public.job_status as enum ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD');
create type public.approval_type as enum (
  'FINAL_PRICING', 'LEGAL_DECLARATION', 'BID_SUBMISSION', 'CLARIFICATION_EMAIL',
  'CONTRACT_ACCEPTANCE', 'FINANCIAL_COMMITMENT', 'SENSITIVE_DOCUMENT_DISCLOSURE', 'EXCEPTION'
);
create type public.approval_status as enum ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');
create type public.risk_level as enum ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
create type public.submission_status as enum ('PREPARING', 'SUBMITTED', 'FAILED', 'ACTION_REQUIRED');

-- ---------------------------------------------------------------------------
-- Workflow runs
-- ---------------------------------------------------------------------------
create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  tender_id uuid not null,
  workflow_key text not null check (workflow_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  workflow_version integer not null default 1,
  status public.workflow_run_status not null default 'PENDING',
  current_step text,
  is_simulation boolean not null default true,
  -- simulation-only knobs (e.g. failure injection); validated by start_tender_workflow
  options jsonb not null default '{}'::jsonb,
  correlation_id uuid not null default gen_random_uuid(),
  max_tasks integer not null check (max_tasks between 1 and 500),
  task_count integer not null default 0 check (task_count >= 0),
  started_by uuid references auth.users (id) on delete set null,
  error text,
  outcome text,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade,
  check (task_count <= max_tasks)
);
-- One active run per tender and workflow: prevents duplicate workflows.
create unique index workflow_runs_one_active_uq on public.workflow_runs (tender_id, workflow_key)
  where status in ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'BLOCKED');
create index workflow_runs_org_status_idx on public.workflow_runs (organisation_id, status, created_at desc);
create trigger workflow_runs_updated_at before update on public.workflow_runs
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  workflow_run_id uuid references public.workflow_runs (id) on delete cascade,
  tender_id uuid,
  agent_id uuid not null,
  parent_task_id uuid references public.tasks (id) on delete set null,
  type text not null check (type ~ '^[a-z][a-z0-9_.]{2,80}$'),
  step_key text,
  title text not null check (char_length(title) <= 200),
  description text not null default '',
  status public.task_status not null default 'QUEUED',
  priority smallint not null default 5 check (priority between 1 and 10),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  progress smallint not null default 0 check (progress between 0 and 100),
  progress_message text,
  error text,
  blocked_reason text,
  retry_count integer not null default 0 check (retry_count >= 0),
  max_retries integer not null default 3 check (max_retries between 0 and 10),
  timeout_seconds integer not null default 300 check (timeout_seconds between 5 and 86400),
  approval_required boolean not null default false,
  approval_id uuid,
  cost_estimate_usd numeric(12, 6),
  actual_cost_usd numeric(12, 6) not null default 0,
  idempotency_key text,
  correlation_id uuid,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (organisation_id, agent_id) references public.agents (organisation_id, id) on delete restrict,
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade,
  check (retry_count <= max_retries + 1)
);
create unique index tasks_idempotency_uq on public.tasks (organisation_id, idempotency_key)
  where idempotency_key is not null;
create index tasks_org_status_idx on public.tasks (organisation_id, status, created_at desc);
create index tasks_agent_status_idx on public.tasks (agent_id, status);
create index tasks_tender_idx on public.tasks (tender_id, created_at) where tender_id is not null;
create index tasks_run_idx on public.tasks (workflow_run_id, created_at);
create trigger tasks_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();

alter table public.agents
  add constraint agents_current_task_fk foreign key (current_task_id) references public.tasks (id) on delete set null,
  add constraint agents_current_tender_fk foreign key (current_tender_id) references public.tenders (id) on delete set null;

create table public.task_dependencies (
  task_id uuid not null references public.tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks (id) on delete cascade,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

-- ---------------------------------------------------------------------------
-- Handoffs: structured, typed transfer of work between agents
-- ---------------------------------------------------------------------------
create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  workflow_run_id uuid references public.workflow_runs (id) on delete cascade,
  tender_id uuid,
  from_agent_id uuid,
  to_agent_id uuid,
  from_task_id uuid references public.tasks (id) on delete set null,
  to_task_id uuid references public.tasks (id) on delete set null,
  to_approval boolean not null default false,
  handoff_type text not null check (handoff_type ~ '^[A-Z][A-Z_]{2,63}$'),
  payload jsonb not null default '{}'::jsonb,
  status public.handoff_status not null default 'PENDING',
  correlation_id uuid,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  foreign key (organisation_id, from_agent_id) references public.agents (organisation_id, id),
  foreign key (organisation_id, to_agent_id) references public.agents (organisation_id, id),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade,
  check (to_agent_id is not null or to_approval)
);
create index handoffs_org_created_idx on public.handoffs (organisation_id, created_at desc);
create index handoffs_run_idx on public.handoffs (workflow_run_id, created_at);

-- ---------------------------------------------------------------------------
-- Approvals (human in the loop)
-- ---------------------------------------------------------------------------
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  type public.approval_type not null,
  requested_by_agent_id uuid,
  tender_id uuid,
  task_id uuid references public.tasks (id) on delete set null,
  workflow_run_id uuid references public.workflow_runs (id) on delete cascade,
  summary text not null check (char_length(summary) <= 1000),
  risk_level public.risk_level not null default 'MEDIUM',
  payload jsonb not null default '{}'::jsonb,
  status public.approval_status not null default 'PENDING',
  requested_at timestamptz not null default now(),
  expires_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  decided_by uuid references auth.users (id) on delete set null,
  comments text check (comments is null or char_length(comments) <= 2000),
  foreign key (organisation_id, requested_by_agent_id) references public.agents (organisation_id, id),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade
);
create index approvals_org_status_idx on public.approvals (organisation_id, status, requested_at desc);
create unique index approvals_one_pending_per_task_uq on public.approvals (task_id) where status = 'PENDING';

alter table public.tasks
  add constraint tasks_approval_fk foreign key (approval_id) references public.approvals (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Submission records
-- ---------------------------------------------------------------------------
create table public.submission_records (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  tender_id uuid not null,
  workflow_run_id uuid references public.workflow_runs (id) on delete set null,
  approval_id uuid not null references public.approvals (id) on delete restrict,
  method public.submission_method not null,
  status public.submission_status not null default 'PREPARING',
  is_simulation boolean not null,
  package_hash text,
  destination text,
  external_reference text,
  receipt jsonb not null default '{}'::jsonb,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade
);
create index submission_records_tender_idx on public.submission_records (tender_id);

-- ---------------------------------------------------------------------------
-- Notifications (in-app first; channel adapters later)
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind ~ '^[A-Z][A-Z_]{2,63}$'),
  severity public.event_severity not null default 'INFO',
  title text not null check (char_length(title) <= 200),
  body text check (body is null or char_length(body) <= 2000),
  link text check (link is null or link ~ '^/'),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, read_at, created_at desc);

create or replace function private.notify_members(
  p_org uuid, p_kind text, p_severity public.event_severity, p_title text, p_body text, p_link text,
  p_roles public.org_role[] default array['owner', 'admin', 'operator']::public.org_role[]
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (organisation_id, user_id, kind, severity, title, body, link)
  select p_org, m.user_id, p_kind, p_severity, p_title, p_body, p_link
  from public.organisation_members m
  where m.organisation_id = p_org and m.role = any (p_roles);
$$;

-- ---------------------------------------------------------------------------
-- Cost usage
-- ---------------------------------------------------------------------------
create table public.cost_usage (
  id bigint generated always as identity primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  agent_id uuid references public.agents (id) on delete set null,
  task_id uuid references public.tasks (id) on delete set null,
  tender_id uuid,
  workflow_run_id uuid references public.workflow_runs (id) on delete set null,
  provider text not null,
  model text not null,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
  is_simulated boolean not null default false,
  created_at timestamptz not null default now()
);
create index cost_usage_org_created_idx on public.cost_usage (organisation_id, created_at desc);
create index cost_usage_tender_idx on public.cost_usage (tender_id) where tender_id is not null;
create trigger cost_usage_append_only before update or delete on public.cost_usage
  for each row execute function private.reject_mutation();

-- ---------------------------------------------------------------------------
-- Job queue (Postgres-backed; worker claims with FOR UPDATE SKIP LOCKED)
-- ---------------------------------------------------------------------------
create table public.jobs (
  id bigint generated always as identity primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9_.]{2,80}$'),
  payload jsonb not null default '{}'::jsonb,
  status public.job_status not null default 'QUEUED',
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index jobs_ready_idx on public.jobs (run_at) where status = 'QUEUED';
create index jobs_running_idx on public.jobs (locked_at) where status = 'RUNNING';
create unique index jobs_dedupe_uq on public.jobs (dedupe_key)
  where dedupe_key is not null and status in ('QUEUED', 'RUNNING');
create trigger jobs_updated_at before update on public.jobs
  for each row execute function private.set_updated_at();

create or replace function private.notify_job()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_notify('tenderos_jobs', new.id::text);
  return new;
end;
$$;
create trigger jobs_notify after insert on public.jobs
  for each row execute function private.notify_job();

create or replace function private.enqueue_job(
  p_org uuid, p_kind text, p_payload jsonb, p_dedupe text default null, p_run_at timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.jobs (organisation_id, kind, payload, dedupe_key, run_at)
  values (p_org, p_kind, coalesce(p_payload, '{}'::jsonb), p_dedupe, p_run_at)
  on conflict (dedupe_key) where dedupe_key is not null and status in ('QUEUED', 'RUNNING') do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- Claim the next ready job. Jobs whose lock is older than p_stale are treated
-- as abandoned by a crashed worker and become claimable again.
create or replace function private.claim_job(p_worker text, p_stale interval default interval '10 minutes')
returns setof public.jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.jobs
     set status = 'QUEUED', locked_at = null, locked_by = null,
         last_error = coalesce(last_error, '') || ' [lock expired]'
   where status = 'RUNNING' and locked_at < now() - p_stale;

  return query
  update public.jobs j
     set status = 'RUNNING', locked_at = now(), locked_by = p_worker, attempts = j.attempts + 1
   where j.id = (
     select id from public.jobs
      where status = 'QUEUED' and run_at <= now()
      order by run_at, id
      for update skip locked
      limit 1
   )
  returning j.*;
end;
$$;
revoke all on function private.claim_job(text, interval) from public;

-- ---------------------------------------------------------------------------
-- RPCs invoked by users (role-checked, audited)
-- ---------------------------------------------------------------------------

-- Start a workflow for a tender. Creates the run and hands it to the worker;
-- the worker's workflow engine decides the steps.
create or replace function public.start_tender_workflow(
  p_tender_id uuid, p_workflow_key text default 'simulated_bid', p_options jsonb default '{}'::jsonb
)
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
  select * into v_t from public.tenders where id = p_tender_id for update;
  if not found or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Tender not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  select * into v_s from public.system_settings where organisation_id = v_t.organisation_id;
  if v_s.kill_switch then
    raise exception 'The emergency kill switch is engaged; workflows cannot start' using errcode = 'check_violation';
  end if;
  if p_workflow_key = 'simulated_bid' and not v_s.simulation_mode then
    raise exception 'Simulation workflows are disabled for this organisation' using errcode = 'check_violation';
  end if;
  if p_workflow_key not in ('simulated_bid') then
    raise exception 'Unknown workflow %', p_workflow_key using errcode = 'check_violation';
  end if;
  if p_workflow_key = 'simulated_bid' and not v_t.is_simulation then
    raise exception 'The simulated workflow only runs on tenders marked as simulation tenders' using errcode = 'check_violation';
  end if;
  p_options := coalesce(p_options, '{}'::jsonb);
  if jsonb_typeof(p_options) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_options) k where k not in ('fail_step', 'fail_times'))
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
    values (v_t.organisation_id, v_t.id, p_workflow_key, 'PENDING', p_workflow_key = 'simulated_bid',
            p_options, v_corr, v_s.max_tasks_per_workflow, auth.uid())
    returning id into v_run;
  exception when unique_violation then
    raise exception 'A workflow is already active for this tender' using errcode = 'unique_violation';
  end;

  perform private.enqueue_job(v_t.organisation_id, 'workflow.start',
    jsonb_build_object('workflow_run_id', v_run), 'workflow.start:' || v_run);
  perform private.emit_event(v_t.organisation_id, 'WORKFLOW_REQUESTED',
    format('Workflow %s requested for "%s"', p_workflow_key, left(v_t.title, 200)),
    jsonb_build_object('workflow_key', p_workflow_key), 'INFO', null, v_t.id, null, v_run, null, null, v_corr);
  perform private.write_audit(v_t.organisation_id, 'workflow.requested', 'workflow_run', v_run::text,
    jsonb_build_object('tender_id', v_t.id, 'workflow_key', p_workflow_key), v_corr);
  return v_run;
end;
$$;

-- Approve or reject a pending approval. Only owners and admins may decide.
create or replace function public.decide_approval(
  p_approval_id uuid, p_approve boolean, p_comments text default null
)
returns public.approval_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.approvals;
  v_status public.approval_status;
  v_corr uuid;
begin
  select * into v_a from public.approvals where id = p_approval_id for update;
  if not found or not private.has_org_role(v_a.organisation_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Approval not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  if v_a.status <> 'PENDING' then
    raise exception 'Approval is already %', v_a.status using errcode = 'check_violation';
  end if;
  if v_a.expires_at is not null and v_a.expires_at < now() then
    update public.approvals set status = 'EXPIRED' where id = v_a.id;
    raise exception 'Approval has expired' using errcode = 'check_violation';
  end if;
  if not p_approve and (p_comments is null or char_length(trim(p_comments)) < 3) then
    raise exception 'A reason is required when rejecting' using errcode = 'check_violation';
  end if;

  v_status := case when p_approve then 'APPROVED'::public.approval_status else 'REJECTED'::public.approval_status end;
  update public.approvals
     set status = v_status,
         decided_by = auth.uid(),
         comments = nullif(trim(p_comments), ''),
         approved_at = case when p_approve then now() end,
         rejected_at = case when not p_approve then now() end
   where id = v_a.id;

  select correlation_id into v_corr from public.workflow_runs where id = v_a.workflow_run_id;

  perform private.emit_event(v_a.organisation_id,
    case when p_approve then 'APPROVAL_GRANTED' else 'APPROVAL_REJECTED' end,
    format('%s approval %s', initcap(replace(v_a.type::text, '_', ' ')),
           case when p_approve then 'granted' else 'rejected' end),
    jsonb_build_object('approval_type', v_a.type, 'comments', p_comments),
    'INFO', v_a.requested_by_agent_id, v_a.tender_id, v_a.task_id, v_a.workflow_run_id, null, v_a.id, v_corr);
  perform private.write_audit(v_a.organisation_id,
    case when p_approve then 'approval.granted' else 'approval.rejected' end,
    'approval', v_a.id::text, jsonb_build_object('type', v_a.type, 'comments', p_comments), v_corr);

  if v_a.workflow_run_id is not null then
    perform private.enqueue_job(v_a.organisation_id, 'approval.decided',
      jsonb_build_object('approval_id', v_a.id, 'workflow_run_id', v_a.workflow_run_id),
      'approval.decided:' || v_a.id);
  end if;
  return v_status;
end;
$$;

-- Operator controls for an agent. Pausing never interrupts a running step
-- mid-write; the worker checks the state before claiming new work.
create or replace function public.set_agent_control(p_agent_id uuid, p_action text, p_reason text default null)
returns public.agent_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ag public.agents;
  v_to public.agent_status;
  v_active int;
begin
  select * into v_ag from public.agents where id = p_agent_id for update;
  if not found or not private.has_org_role(v_ag.organisation_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Agent not found or not permitted' using errcode = 'insufficient_privilege';
  end if;

  case p_action
    when 'pause' then
      if v_ag.status in ('PAUSED', 'DISABLED') then raise exception 'Agent is already %', v_ag.status using errcode = 'check_violation'; end if;
      v_to := 'PAUSED';
    when 'disable' then
      if v_ag.status = 'DISABLED' then raise exception 'Agent is already disabled' using errcode = 'check_violation'; end if;
      v_to := 'DISABLED';
    when 'resume', 'enable' then
      if v_ag.status not in ('PAUSED', 'DISABLED') then raise exception 'Agent is not paused or disabled' using errcode = 'check_violation'; end if;
      select count(*) into v_active from public.tasks
        where agent_id = v_ag.id and status in ('QUEUED', 'WAITING', 'BLOCKED');
      v_to := case when v_active > 0 then 'QUEUED'::public.agent_status else 'IDLE'::public.agent_status end;
    else
      raise exception 'Unknown action %', p_action using errcode = 'check_violation';
  end case;

  update public.agents
     set status = v_to,
         status_reason = coalesce(nullif(trim(p_reason), ''), 'Set by operator'),
         last_action = format('Operator %s', p_action),
         last_action_at = now()
   where id = v_ag.id;

  perform private.emit_event(v_ag.organisation_id, 'AGENT_' || upper(case p_action when 'enable' then 'enabled' when 'disable' then 'disabled' when 'pause' then 'paused' else 'resumed' end),
    format('%s %s by operator', v_ag.display_name, case p_action when 'enable' then 'enabled' when 'disable' then 'disabled' when 'pause' then 'paused' else 'resumed' end),
    jsonb_build_object('from', v_ag.status, 'to', v_to, 'reason', p_reason), 'WARNING', v_ag.id);
  perform private.write_audit(v_ag.organisation_id, 'agent.' || p_action, 'agent', v_ag.id::text,
    jsonb_build_object('from', v_ag.status, 'to', v_to, 'reason', p_reason));

  if v_to in ('QUEUED', 'IDLE') then
    -- wake any jobs that were deferred while the agent was paused
    update public.jobs set run_at = now()
     where status = 'QUEUED' and kind = 'task.run'
       and (payload ->> 'task_id')::uuid in (select id from public.tasks where agent_id = v_ag.id and status in ('QUEUED', 'WAITING', 'BLOCKED'));
  end if;
  return v_to;
end;
$$;

-- Retry a failed task after human review.
create or replace function public.retry_task(p_task_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks;
  v_corr uuid;
begin
  select * into v_task from public.tasks where id = p_task_id for update;
  if not found or not private.has_org_role(v_task.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Task not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  if v_task.status <> 'FAILED' then
    raise exception 'Only failed tasks can be retried (task is %)', v_task.status using errcode = 'check_violation';
  end if;
  update public.tasks
     set status = 'QUEUED', error = null, failed_at = null, retry_count = 0, progress = 0,
         progress_message = 'Retry requested by operator'
   where id = v_task.id;
  update public.workflow_runs set status = 'RUNNING', error = null
   where id = v_task.workflow_run_id and status = 'BLOCKED';
  select correlation_id into v_corr from public.workflow_runs where id = v_task.workflow_run_id;
  perform private.enqueue_job(v_task.organisation_id, 'task.run', jsonb_build_object('task_id', v_task.id),
    'task.run:' || v_task.id);
  perform private.emit_event(v_task.organisation_id, 'TASK_RETRY_REQUESTED',
    format('Retry requested for "%s"', v_task.title), '{}'::jsonb, 'INFO',
    v_task.agent_id, v_task.tender_id, v_task.id, v_task.workflow_run_id, null, null, v_corr);
  perform private.write_audit(v_task.organisation_id, 'task.retry_requested', 'task', v_task.id::text, '{}'::jsonb, v_corr);
end;
$$;

-- Cancel an active workflow run.
create or replace function public.cancel_workflow(p_run_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.workflow_runs;
begin
  select * into v_run from public.workflow_runs where id = p_run_id for update;
  if not found or not private.has_org_role(v_run.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Workflow not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  if v_run.status not in ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'BLOCKED') then
    raise exception 'Workflow is already %', v_run.status using errcode = 'check_violation';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required' using errcode = 'check_violation';
  end if;
  update public.workflow_runs set status = 'CANCELLED', outcome = 'CANCELLED', error = left(p_reason, 500),
         completed_at = now() where id = v_run.id;
  update public.tasks set status = 'CANCELLED', blocked_reason = 'Workflow cancelled'
   where workflow_run_id = v_run.id and status in ('QUEUED', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'FAILED');
  update public.approvals set status = 'CANCELLED' where workflow_run_id = v_run.id and status = 'PENDING';
  update public.handoffs set status = 'CANCELLED' where workflow_run_id = v_run.id and status = 'PENDING';
  -- refresh affected agents
  perform private.enqueue_job(v_run.organisation_id, 'agents.refresh', jsonb_build_object('workflow_run_id', v_run.id));
  perform private.emit_event(v_run.organisation_id, 'WORKFLOW_CANCELLED', 'Workflow cancelled by operator',
    jsonb_build_object('reason', p_reason), 'WARNING', null, v_run.tender_id, null, v_run.id, null, null, v_run.correlation_id);
  perform private.write_audit(v_run.organisation_id, 'workflow.cancelled', 'workflow_run', v_run.id::text,
    jsonb_build_object('reason', p_reason), v_run.correlation_id);
end;
$$;

create or replace function public.set_kill_switch(p_org uuid, p_engaged boolean, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required' using errcode = 'check_violation';
  end if;
  update public.system_settings set kill_switch = p_engaged, updated_by = auth.uid() where organisation_id = p_org;
  perform private.emit_event(p_org, case when p_engaged then 'KILL_SWITCH_ENGAGED' else 'KILL_SWITCH_RELEASED' end,
    case when p_engaged then 'Emergency kill switch engaged' else 'Emergency kill switch released' end,
    jsonb_build_object('reason', p_reason), case when p_engaged then 'CRITICAL'::public.event_severity else 'WARNING'::public.event_severity end);
  perform private.write_audit(p_org, case when p_engaged then 'settings.kill_switch_engaged' else 'settings.kill_switch_released' end,
    'system_settings', p_org::text, jsonb_build_object('reason', p_reason));
  if not p_engaged then
    update public.jobs set run_at = now() where organisation_id = p_org and status = 'QUEUED';
  end if;
end;
$$;

create or replace function public.mark_notifications_read(p_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.notifications set read_at = now()
   where id = any (p_ids) and user_id = (select auth.uid()) and read_at is null;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.workflow_runs enable row level security;
alter table public.tasks enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.handoffs enable row level security;
alter table public.approvals enable row level security;
alter table public.submission_records enable row level security;
alter table public.notifications enable row level security;
alter table public.cost_usage enable row level security;
alter table public.jobs enable row level security; -- no policies: worker/service only

create policy "members read runs" on public.workflow_runs
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read tasks" on public.tasks
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read task deps" on public.task_dependencies
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read handoffs" on public.handoffs
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read approvals" on public.approvals
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read submissions" on public.submission_records
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "users read own notifications" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy "members read cost usage" on public.cost_usage
  for select to authenticated using (private.is_org_member(organisation_id));

revoke all on public.workflow_runs, public.tasks, public.task_dependencies, public.handoffs,
  public.approvals, public.submission_records, public.notifications, public.cost_usage, public.jobs from anon;
revoke insert, update, delete, truncate on public.workflow_runs, public.tasks, public.task_dependencies,
  public.handoffs, public.approvals, public.submission_records, public.notifications, public.cost_usage from authenticated;
revoke all on public.jobs from authenticated;

revoke execute on function public.start_tender_workflow(uuid, text, jsonb) from public, anon;
revoke execute on function public.decide_approval(uuid, boolean, text) from public, anon;
revoke execute on function public.set_agent_control(uuid, text, text) from public, anon;
revoke execute on function public.retry_task(uuid) from public, anon;
revoke execute on function public.cancel_workflow(uuid, text) from public, anon;
revoke execute on function public.set_kill_switch(uuid, boolean, text) from public, anon;
revoke execute on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.start_tender_workflow(uuid, text, jsonb) to authenticated;
grant execute on function public.decide_approval(uuid, boolean, text) to authenticated;
grant execute on function public.set_agent_control(uuid, text, text) to authenticated;
grant execute on function public.retry_task(uuid) to authenticated;
grant execute on function public.cancel_workflow(uuid, text) to authenticated;
grant execute on function public.set_kill_switch(uuid, boolean, text) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- Private helpers must never be callable by end users directly.
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_org_member(uuid) to authenticated;
grant execute on function private.has_org_role(uuid, public.org_role[]) to authenticated;
grant execute on function private.shares_org_with(uuid) to authenticated;
