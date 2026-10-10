-- Agent organisation: departments, agent registry, permissions, state history,
-- and the append-only agent event stream.

create type public.agent_status as enum (
  'IDLE', 'QUEUED', 'RUNNING', 'WAITING', 'BLOCKED',
  'NEEDS_APPROVAL', 'PAUSED', 'COMPLETED', 'FAILED', 'DISABLED'
);
create type public.cost_tier as enum ('LOW', 'MID', 'HIGH');
create type public.data_category as enum (
  'PUBLIC_TENDER_DATA',
  'TENDER_DOCUMENTS',
  'COMPANY_PROFILE',
  'COMPANY_CAPABILITIES',
  'PROJECT_REFERENCES',
  'FINANCIAL',
  'BANKING',
  'TAX',
  'BBBEE',
  'DIRECTOR_PERSONAL',
  'PROOF_OF_ADDRESS',
  'INSURANCE',
  'CERTIFICATIONS',
  'PRICING',
  'COMMUNICATIONS',
  'SUBMISSION'
);
create type public.access_level as enum ('READ', 'WRITE');
create type public.event_severity as enum ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL');

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text not null,
  description text not null default '',
  accent text not null default 'slate',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (organisation_id, slug)
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  department_id uuid not null references public.departments (id) on delete restrict,
  slug text not null check (slug ~ '^[a-z][a-z0-9_]{1,62}$'),
  display_name text not null,
  role_title text not null,
  description text not null default '',
  responsibilities text[] not null default '{}',
  allowed_tools text[] not null default '{}',
  model_tier public.cost_tier not null default 'LOW',
  model_override text,
  max_concurrent_tasks integer not null default 1 check (max_concurrent_tasks between 1 and 20),
  escalation_policy jsonb not null default '{}'::jsonb,
  daily_budget_usd numeric(12, 4) check (daily_budget_usd is null or daily_budget_usd >= 0),
  status public.agent_status not null default 'IDLE',
  status_reason text,
  status_changed_at timestamptz not null default now(),
  current_task_id uuid,
  current_tender_id uuid,
  last_action text,
  last_action_at timestamptz,
  next_expected_action text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, slug),
  unique (organisation_id, id)
);
create index agents_department_idx on public.agents (department_id);
create trigger agents_updated_at before update on public.agents
  for each row execute function private.set_updated_at();

create table public.agent_permissions (
  agent_id uuid not null references public.agents (id) on delete cascade,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  data_category public.data_category not null,
  access public.access_level not null default 'READ',
  created_at timestamptz not null default now(),
  primary key (agent_id, data_category)
);
create index agent_permissions_org_idx on public.agent_permissions (organisation_id);

create table public.agent_status_transitions (
  id bigint generated always as identity primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  agent_id uuid not null references public.agents (id) on delete cascade,
  from_status public.agent_status,
  to_status public.agent_status not null,
  reason text,
  task_id uuid,
  created_at timestamptz not null default now()
);
create index agent_status_transitions_agent_idx
  on public.agent_status_transitions (agent_id, created_at desc);
create trigger agent_status_transitions_append_only before update or delete
  on public.agent_status_transitions
  for each row execute function private.reject_mutation();

create or replace function private.stamp_agent_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;
create trigger agents_stamp_status before insert or update of status on public.agents
  for each row execute function private.stamp_agent_status();

create or replace function private.record_agent_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.agent_status_transitions (organisation_id, agent_id, from_status, to_status, reason, task_id)
    values (new.organisation_id, new.id,
            case when tg_op = 'UPDATE' then old.status end,
            new.status, new.status_reason, new.current_task_id);
  end if;
  return null;
end;
$$;
create trigger agents_record_status after insert or update of status on public.agents
  for each row execute function private.record_agent_status();

-- Event stream. Every significant action produces a row here. The table is
-- append-only and is the source for the live activity feed.
create table public.agent_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  event_type text not null check (event_type ~ '^[A-Z][A-Z_]{2,63}$'),
  severity public.event_severity not null default 'INFO',
  agent_id uuid references public.agents (id) on delete set null,
  tender_id uuid,
  task_id uuid,
  workflow_run_id uuid,
  handoff_id uuid,
  approval_id uuid,
  actor_user_id uuid references auth.users (id) on delete set null,
  correlation_id uuid,
  causation_id uuid,
  summary text not null check (char_length(summary) <= 500),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index agent_events_org_created_idx on public.agent_events (organisation_id, created_at desc);
create index agent_events_tender_idx on public.agent_events (tender_id, created_at desc) where tender_id is not null;
create index agent_events_agent_idx on public.agent_events (agent_id, created_at desc) where agent_id is not null;
create index agent_events_run_idx on public.agent_events (workflow_run_id, created_at) where workflow_run_id is not null;
create index agent_events_correlation_idx on public.agent_events (correlation_id) where correlation_id is not null;
create trigger agent_events_append_only before update or delete on public.agent_events
  for each row execute function private.reject_mutation();

create or replace function private.emit_event(
  p_org uuid,
  p_type text,
  p_summary text,
  p_payload jsonb default '{}'::jsonb,
  p_severity public.event_severity default 'INFO',
  p_agent uuid default null,
  p_tender uuid default null,
  p_task uuid default null,
  p_run uuid default null,
  p_handoff uuid default null,
  p_approval uuid default null,
  p_correlation uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.agent_events (
    organisation_id, event_type, severity, agent_id, tender_id, task_id,
    workflow_run_id, handoff_id, approval_id, actor_user_id, correlation_id, summary, payload
  ) values (
    p_org, p_type, p_severity, p_agent, p_tender, p_task,
    p_run, p_handoff, p_approval, auth.uid(), p_correlation, p_summary, coalesce(p_payload, '{}'::jsonb)
  ) returning id into v_id;
  return v_id;
end;
$$;

alter table public.departments enable row level security;
alter table public.agents enable row level security;
alter table public.agent_permissions enable row level security;
alter table public.agent_status_transitions enable row level security;
alter table public.agent_events enable row level security;

create policy "members read departments" on public.departments
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read agents" on public.agents
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read agent permissions" on public.agent_permissions
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read agent transitions" on public.agent_status_transitions
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read events" on public.agent_events
  for select to authenticated using (private.is_org_member(organisation_id));

revoke all on public.departments, public.agents, public.agent_permissions,
  public.agent_status_transitions, public.agent_events from anon;
revoke insert, update, delete, truncate on public.departments, public.agents, public.agent_permissions,
  public.agent_status_transitions, public.agent_events from authenticated;
