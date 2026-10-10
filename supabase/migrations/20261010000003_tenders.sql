-- Tenders, sources, and the tender state machine.

create type public.tender_status as enum (
  'DISCOVERED', 'INGESTING', 'ANALYSING', 'QUALIFYING', 'REJECTED', 'QUALIFIED',
  'COMPLIANCE_REVIEW', 'MISSING_INFORMATION', 'PREPARING_BID', 'PRICING',
  'QUALITY_ASSURANCE', 'QA_FAILED', 'READY_FOR_APPROVAL', 'APPROVED', 'SUBMITTING',
  'SUBMITTED', 'SUBMISSION_FAILED', 'UNDER_EVALUATION', 'CLARIFICATION',
  'AWARDED', 'UNSUCCESSFUL', 'CANCELLED', 'ARCHIVED'
);
create type public.submission_method as enum ('ELECTRONIC_PORTAL', 'EMAIL', 'PHYSICAL', 'UNKNOWN');
create type public.tender_source_kind as enum ('MANUAL', 'PORTAL', 'EMAIL', 'API');

create table public.tender_sources (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text not null,
  kind public.tender_source_kind not null,
  base_url text,
  enabled boolean not null default true,
  -- connector configuration; never store credentials here (use server-side secrets)
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organisation_id, slug)
);

create table public.tenders (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  source_id uuid references public.tender_sources (id) on delete set null,
  reference_number text check (reference_number is null or char_length(reference_number) between 1 and 120),
  title text not null check (char_length(title) between 3 and 300),
  issuing_organisation text not null check (char_length(issuing_organisation) between 2 and 200),
  description text check (description is null or char_length(description) <= 10000),
  province text not null default 'UNKNOWN' check (province in (
    'EASTERN_CAPE', 'FREE_STATE', 'GAUTENG', 'KWAZULU_NATAL', 'LIMPOPO', 'MPUMALANGA',
    'NORTH_WEST', 'NORTHERN_CAPE', 'WESTERN_CAPE', 'NATIONAL', 'UNKNOWN')),
  sector text check (sector is null or char_length(sector) <= 120),
  estimated_value_zar numeric(16, 2) check (estimated_value_zar is null or estimated_value_zar >= 0),
  published_at timestamptz,
  closing_at timestamptz not null,
  briefing_at timestamptz,
  briefing_compulsory boolean not null default false,
  briefing_location text check (briefing_location is null or char_length(briefing_location) <= 300),
  questions_deadline_at timestamptz,
  submission_method public.submission_method not null default 'UNKNOWN',
  submission_destination text check (submission_destination is null or char_length(submission_destination) <= 500),
  source_url text check (source_url is null or source_url ~ '^https?://'),
  status public.tender_status not null default 'DISCOVERED',
  status_changed_at timestamptz not null default now(),
  is_simulation boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (published_at is null or published_at <= closing_at),
  check (briefing_at is null or briefing_at <= closing_at),
  unique (organisation_id, id)
);
create unique index tenders_org_reference_uq on public.tenders (organisation_id, reference_number)
  where reference_number is not null;
create index tenders_org_status_idx on public.tenders (organisation_id, status);
create index tenders_org_closing_idx on public.tenders (organisation_id, closing_at);
create trigger tenders_updated_at before update on public.tenders
  for each row execute function private.set_updated_at();

create table public.tender_status_history (
  id bigint generated always as identity primary key,
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  tender_id uuid not null references public.tenders (id) on delete cascade,
  from_status public.tender_status,
  to_status public.tender_status not null,
  reason text,
  actor_type public.actor_type not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_agent_id uuid,
  created_at timestamptz not null default now()
);
create index tender_status_history_tender_idx on public.tender_status_history (tender_id, created_at);
create trigger tender_status_history_append_only before update or delete on public.tender_status_history
  for each row execute function private.reject_mutation();

-- Allowed transitions. Mirrored in lib/domain/tender-state.ts; an integration
-- test asserts both agree.
create or replace function private.tender_transition_allowed(
  p_from public.tender_status, p_to public.tender_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'DISCOVERED' then p_to in ('INGESTING', 'QUALIFYING', 'REJECTED', 'CANCELLED', 'ARCHIVED')
    when 'INGESTING' then p_to in ('ANALYSING', 'CANCELLED')
    when 'ANALYSING' then p_to in ('QUALIFYING', 'CANCELLED')
    when 'QUALIFYING' then p_to in ('QUALIFIED', 'REJECTED', 'CANCELLED')
    when 'REJECTED' then p_to in ('QUALIFYING', 'ARCHIVED')
    when 'QUALIFIED' then p_to in ('COMPLIANCE_REVIEW', 'CANCELLED')
    when 'COMPLIANCE_REVIEW' then p_to in ('PREPARING_BID', 'MISSING_INFORMATION', 'CANCELLED')
    when 'MISSING_INFORMATION' then p_to in ('COMPLIANCE_REVIEW', 'CANCELLED')
    when 'PREPARING_BID' then p_to in ('PRICING', 'QUALITY_ASSURANCE', 'CLARIFICATION', 'CANCELLED')
    when 'PRICING' then p_to in ('QUALITY_ASSURANCE', 'PREPARING_BID', 'CANCELLED')
    when 'QUALITY_ASSURANCE' then p_to in ('READY_FOR_APPROVAL', 'QA_FAILED', 'CANCELLED')
    when 'QA_FAILED' then p_to in ('PREPARING_BID', 'PRICING', 'CANCELLED')
    when 'READY_FOR_APPROVAL' then p_to in ('APPROVED', 'PREPARING_BID', 'CANCELLED')
    when 'APPROVED' then p_to in ('SUBMITTING', 'CANCELLED')
    when 'SUBMITTING' then p_to in ('SUBMITTED', 'SUBMISSION_FAILED')
    when 'SUBMISSION_FAILED' then p_to in ('SUBMITTING', 'READY_FOR_APPROVAL', 'CANCELLED')
    when 'SUBMITTED' then p_to in ('UNDER_EVALUATION', 'CLARIFICATION', 'AWARDED', 'UNSUCCESSFUL')
    when 'UNDER_EVALUATION' then p_to in ('CLARIFICATION', 'AWARDED', 'UNSUCCESSFUL', 'CANCELLED')
    when 'CLARIFICATION' then p_to in ('UNDER_EVALUATION', 'PREPARING_BID', 'CANCELLED')
    when 'AWARDED' then p_to in ('ARCHIVED')
    when 'UNSUCCESSFUL' then p_to in ('ARCHIVED')
    when 'CANCELLED' then p_to in ('ARCHIVED')
    else false
  end;
$$;

create or replace function private.guard_tender_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_agent uuid := nullif(current_setting('app.actor_agent_id', true), '')::uuid;
  v_reason text := nullif(current_setting('app.transition_reason', true), '');
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DISCOVERED' then
      raise exception 'New tenders must start in DISCOVERED' using errcode = 'check_violation';
    end if;
    return new; -- creation history is written by the AFTER INSERT trigger
  end if;

  if new.status is distinct from old.status then
    if not private.tender_transition_allowed(old.status, new.status) then
      raise exception 'Invalid tender transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    new.status_changed_at := now();
    insert into public.tender_status_history (organisation_id, tender_id, from_status, to_status, reason, actor_type, actor_user_id, actor_agent_id)
    values (new.organisation_id, new.id, old.status, new.status, v_reason,
            case when v_user is not null then 'user'::public.actor_type when v_agent is not null then 'agent'::public.actor_type else 'system'::public.actor_type end,
            v_user, v_agent);
  end if;
  return new;
end;
$$;
create trigger tenders_guard_status before insert or update of status on public.tenders
  for each row execute function private.guard_tender_status();

-- Stamp creator, emit TENDER_CREATED and audit when a user creates a tender.
create or replace function private.on_tender_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_agent uuid := nullif(current_setting('app.actor_agent_id', true), '')::uuid;
begin
  insert into public.tender_status_history (organisation_id, tender_id, from_status, to_status, reason, actor_type, actor_user_id, actor_agent_id)
  values (new.organisation_id, new.id, null, new.status, 'Tender created',
          case when v_user is not null then 'user'::public.actor_type when v_agent is not null then 'agent'::public.actor_type else 'system'::public.actor_type end,
          v_user, v_agent);
  perform private.emit_event(
    new.organisation_id, 'TENDER_CREATED',
    format('Tender "%s" created', left(new.title, 200)),
    jsonb_build_object('reference_number', new.reference_number, 'is_simulation', new.is_simulation),
    'INFO', null, new.id
  );
  perform private.write_audit(new.organisation_id, 'tender.created', 'tender', new.id::text,
    jsonb_build_object('title', new.title, 'reference_number', new.reference_number));
  return new;
end;
$$;
create trigger tenders_after_insert after insert on public.tenders
  for each row execute function private.on_tender_created();

create or replace function private.stamp_tender_creator()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;
create trigger tenders_stamp_creator before insert on public.tenders
  for each row execute function private.stamp_tender_creator();

-- User-initiated transitions (cancel, archive, outcome recording) go through
-- this RPC so they are role-checked, logged, and audited.
create or replace function public.transition_tender(
  p_tender_id uuid, p_to public.tender_status, p_reason text
)
returns public.tender_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
begin
  select * into v_t from public.tenders where id = p_tender_id for update;
  if not found or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Tender not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  if p_to not in ('CANCELLED', 'ARCHIVED', 'UNDER_EVALUATION', 'AWARDED', 'UNSUCCESSFUL') then
    raise exception 'Status % can only be set by the workflow engine', p_to using errcode = 'check_violation';
  end if;
  if p_reason is null or char_length(trim(p_reason)) < 3 then
    raise exception 'A reason is required' using errcode = 'check_violation';
  end if;
  perform set_config('app.transition_reason', left(p_reason, 500), true);
  update public.tenders set status = p_to where id = p_tender_id;
  perform private.emit_event(v_t.organisation_id, 'TENDER_STATUS_CHANGED',
    format('Tender moved from %s to %s', v_t.status, p_to),
    jsonb_build_object('from', v_t.status, 'to', p_to, 'reason', p_reason), 'INFO', null, v_t.id);
  perform private.write_audit(v_t.organisation_id, 'tender.status_changed', 'tender', v_t.id::text,
    jsonb_build_object('from', v_t.status, 'to', p_to, 'reason', p_reason));
  return p_to;
end;
$$;

alter table public.tender_sources enable row level security;
alter table public.tenders enable row level security;
alter table public.tender_status_history enable row level security;

create policy "members read sources" on public.tender_sources
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "members read tenders" on public.tenders
  for select to authenticated using (private.is_org_member(organisation_id));
create policy "operators create tenders" on public.tenders
  for insert to authenticated
  with check (private.has_org_role(organisation_id, array['owner', 'admin', 'operator']::public.org_role[]));
create policy "operators edit tender details" on public.tenders
  for update to authenticated
  using (private.has_org_role(organisation_id, array['owner', 'admin', 'operator']::public.org_role[]))
  with check (private.has_org_role(organisation_id, array['owner', 'admin', 'operator']::public.org_role[]));
create policy "members read tender history" on public.tender_status_history
  for select to authenticated using (private.is_org_member(organisation_id));

revoke all on public.tender_sources, public.tenders, public.tender_status_history from anon;
revoke insert, update, delete, truncate on public.tender_sources, public.tender_status_history from authenticated;
revoke update, delete, truncate on public.tenders from authenticated;
-- Users may edit descriptive fields only; status, organisation and simulation
-- flag are controlled by the system.
grant update (
  reference_number, title, issuing_organisation, description, province, sector,
  estimated_value_zar, published_at, closing_at, briefing_at, briefing_compulsory,
  briefing_location, questions_deadline_at, submission_method, submission_destination, source_url
) on public.tenders to authenticated;
revoke insert on public.tenders from authenticated;
grant insert (
  organisation_id, source_id, reference_number, title, issuing_organisation, description, province, sector,
  estimated_value_zar, published_at, closing_at, briefing_at, briefing_compulsory,
  briefing_location, questions_deadline_at, submission_method, submission_destination, source_url, is_simulation
) on public.tenders to authenticated;

revoke execute on function public.transition_tender(uuid, public.tender_status, text) from public, anon;
grant execute on function public.transition_tender(uuid, public.tender_status, text) to authenticated;
