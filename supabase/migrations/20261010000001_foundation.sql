-- TenderOS foundation: tenancy, roles, profiles, settings, audit log.
-- Conventions:
--   * every tenant-owned row carries organisation_id and is protected by RLS;
--   * helper functions used by policies live in the non-exposed `private` schema;
--   * timestamps are timestamptz, ids are uuid (gen_random_uuid) unless the table
--     is an append-only high-volume log.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enums (only for small, stable vocabularies)
-- ---------------------------------------------------------------------------
create type public.org_role as enum ('owner', 'admin', 'operator', 'viewer');
create type public.actor_type as enum ('user', 'agent', 'system');

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Table %.% is append-only', tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end;
$$;

-- ---------------------------------------------------------------------------
-- Organisations and membership
-- ---------------------------------------------------------------------------
create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organisations_updated_at before update on public.organisations
  for each row execute function private.set_updated_at();

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text check (full_name is null or char_length(full_name) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();

create table public.organisation_members (
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);
create index organisation_members_user_idx on public.organisation_members (user_id);

-- Create a profile row whenever an auth user is created.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Membership checks used by RLS. SECURITY DEFINER so policies on
-- organisation_members itself do not recurse.
create or replace function private.is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organisation_members m
    where m.organisation_id = p_org and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.has_org_role(p_org uuid, p_roles public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organisation_members m
    where m.organisation_id = p_org
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;

create or replace function private.shares_org_with(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organisation_members a
    join public.organisation_members b on a.organisation_id = b.organisation_id
    where a.user_id = (select auth.uid()) and b.user_id = p_user
  );
$$;

grant execute on function private.is_org_member(uuid) to authenticated, service_role;
grant execute on function private.has_org_role(uuid, public.org_role[]) to authenticated, service_role;
grant execute on function private.shares_org_with(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- System settings (one row per organisation)
-- ---------------------------------------------------------------------------
create table public.system_settings (
  organisation_id uuid primary key references public.organisations (id) on delete cascade,
  simulation_mode boolean not null default true,
  kill_switch boolean not null default false,
  daily_ai_budget_usd numeric(12, 4) not null default 5 check (daily_ai_budget_usd >= 0),
  monthly_ai_budget_usd numeric(12, 4) not null default 100 check (monthly_ai_budget_usd >= 0),
  per_tender_budget_usd numeric(12, 4) not null default 10 check (per_tender_budget_usd >= 0),
  budget_warning_pct integer not null default 80 check (budget_warning_pct between 1 and 100),
  max_tasks_per_workflow integer not null default 40 check (max_tasks_per_workflow between 1 and 500),
  default_max_retries integer not null default 3 check (default_max_retries between 0 and 10),
  audit_retention_days integer not null default 2555 check (audit_retention_days >= 365),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id)
);
create trigger system_settings_updated_at before update on public.system_settings
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organisation_id uuid references public.organisations (id) on delete restrict,
  actor_type public.actor_type not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_agent_id uuid,
  action text not null check (action ~ '^[a-z][a-z0-9_.]{2,80}$'),
  resource_type text not null,
  resource_id text,
  correlation_id uuid,
  ip inet,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_org_created_idx on public.audit_logs (organisation_id, created_at desc);
create index audit_logs_resource_idx on public.audit_logs (resource_type, resource_id);
create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function private.reject_mutation();

-- Single entry point for audit writes from SQL. The actor is resolved from the
-- session: an authenticated user, or an agent id set by the worker via
-- `set local app.actor_agent_id`.
create or replace function private.write_audit(
  p_org uuid,
  p_action text,
  p_resource_type text,
  p_resource_id text,
  p_metadata jsonb default '{}'::jsonb,
  p_correlation uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_agent uuid := nullif(current_setting('app.actor_agent_id', true), '')::uuid;
begin
  insert into public.audit_logs (
    organisation_id, actor_type, actor_user_id, actor_agent_id,
    action, resource_type, resource_id, correlation_id, metadata
  ) values (
    p_org,
    case when v_user is not null then 'user'::public.actor_type
         when v_agent is not null then 'agent'::public.actor_type
         else 'system'::public.actor_type end,
    v_user, v_agent, p_action, p_resource_type, p_resource_id, p_correlation,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.organisations enable row level security;
alter table public.profiles enable row level security;
alter table public.organisation_members enable row level security;
alter table public.system_settings enable row level security;
alter table public.audit_logs enable row level security;

create policy "members read their organisations" on public.organisations
  for select to authenticated using (private.is_org_member(id));
create policy "owners and admins update organisation" on public.organisations
  for update to authenticated
  using (private.has_org_role(id, array['owner', 'admin']::public.org_role[]))
  with check (private.has_org_role(id, array['owner', 'admin']::public.org_role[]));

create policy "read own or colleague profiles" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or private.shares_org_with(id));
create policy "update own profile" on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "members read membership" on public.organisation_members
  for select to authenticated using (private.is_org_member(organisation_id));

create policy "members read settings" on public.system_settings
  for select to authenticated using (private.is_org_member(organisation_id));

create policy "admins read audit log" on public.audit_logs
  for select to authenticated
  using (private.has_org_role(organisation_id, array['owner', 'admin']::public.org_role[]));

-- Defence in depth: anonymous users get nothing, and direct writes are only
-- allowed where a policy or column grant says so.
revoke all on public.organisations, public.profiles, public.organisation_members,
  public.system_settings, public.audit_logs from anon;
revoke insert, update, delete, truncate on public.organisations, public.organisation_members,
  public.system_settings, public.audit_logs from authenticated;
revoke update on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;
grant update (name) on public.organisations to authenticated;
