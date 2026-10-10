-- Which ways of delivering a bid the organisation wants the Tender Scout to
-- pick up: uploading on a portal, emailing, or delivering in person. Tenders
-- that don't state a method are kept unless the organisation opts out.

create or replace function private.valid_methods(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(p) > 0
     and coalesce(bool_and(x in ('ELECTRONIC_PORTAL', 'EMAIL', 'PHYSICAL', 'UNKNOWN')), true)
  from unnest(p) x;
$$;

alter table public.system_settings
  add column watched_methods text[] not null default '{ELECTRONIC_PORTAL,EMAIL,PHYSICAL,UNKNOWN}'
    check (private.valid_methods(watched_methods));

alter table public.discovery_runs
  add column methods text[] not null default '{ELECTRONIC_PORTAL,EMAIL,PHYSICAL,UNKNOWN}'
    check (private.valid_methods(methods));

create index tenders_org_method_idx on public.tenders (organisation_id, submission_method)
  where source_ref is not null;

create or replace function public.set_watched_methods(p_org uuid, p_methods text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can change delivery methods' using errcode = 'insufficient_privilege';
  end if;
  if p_methods is null or not private.valid_methods(p_methods) then
    raise exception 'Choose at least one delivery method' using errcode = 'check_violation';
  end if;
  update public.system_settings
     set watched_methods = (select array_agg(distinct x order by x) from unnest(p_methods) x),
         updated_by = auth.uid()
   where organisation_id = p_org;
  perform private.write_audit(p_org, 'settings.watched_methods', 'system_settings', p_org::text,
    jsonb_build_object('methods', p_methods));
end;
$$;

-- Each scan records the methods it was asked for, so a settings change made
-- while a scan runs doesn't change that scan.
create or replace function private.queue_discovery(p_org uuid, p_provinces text[], p_trigger text, p_user uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_methods text[];
begin
  if exists (select 1 from public.discovery_runs where organisation_id = p_org and status in ('QUEUED', 'RUNNING')) then
    select id into v_id from public.discovery_runs where organisation_id = p_org and status in ('QUEUED', 'RUNNING') limit 1;
    return v_id;
  end if;
  select watched_methods into v_methods from public.system_settings where organisation_id = p_org;
  insert into public.discovery_runs (organisation_id, provinces, methods, trigger, requested_by)
  values (p_org, p_provinces, coalesce(v_methods, '{ELECTRONIC_PORTAL,EMAIL,PHYSICAL,UNKNOWN}'), p_trigger, p_user)
  returning id into v_id;
  perform private.enqueue_job(p_org, 'discovery.run', jsonb_build_object('discovery_run_id', v_id), 'discovery.run:' || v_id);
  perform private.emit_event(p_org, 'DISCOVERY_REQUESTED',
    format('Tender scan requested for %s', array_to_string(p_provinces, ', ')),
    jsonb_build_object('discovery_run_id', v_id, 'provinces', p_provinces, 'methods', v_methods, 'trigger', p_trigger));
  return v_id;
end;
$$;

revoke all on function private.valid_methods(text[]) from public;
grant execute on function private.valid_methods(text[]) to authenticated, service_role;
revoke all on function private.queue_discovery(uuid, text[], text, uuid) from public, anon, authenticated;
revoke execute on function public.set_watched_methods(uuid, text[]) from public, anon;
grant execute on function public.set_watched_methods(uuid, text[]) to authenticated;
