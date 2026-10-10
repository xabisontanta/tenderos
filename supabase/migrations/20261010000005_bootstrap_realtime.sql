-- Organisation bootstrap and realtime publication.

-- Creates an organisation for a user and installs the agent registry.
-- The registry (departments, agents, permissions) is defined in application
-- code (lib/agents/registry.ts) and passed in by the server, so there is a
-- single source of truth. Only the service role may call this.
create or replace function public.bootstrap_organisation(
  p_user_id uuid,
  p_name text,
  p_slug text,
  p_departments jsonb,
  p_agents jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_dep jsonb;
  v_ag jsonb;
  v_dep_id uuid;
  v_agent_id uuid;
  v_cat text;
begin
  if exists (select 1 from public.organisation_members where user_id = p_user_id) then
    raise exception 'User already belongs to an organisation' using errcode = 'unique_violation';
  end if;

  insert into public.organisations (name, slug) values (p_name, p_slug) returning id into v_org;
  insert into public.organisation_members (organisation_id, user_id, role) values (v_org, p_user_id, 'owner');
  insert into public.system_settings (organisation_id, updated_by) values (v_org, p_user_id);
  insert into public.tender_sources (organisation_id, slug, name, kind)
  values (v_org, 'manual', 'Manual entry', 'MANUAL');

  for v_dep in select * from jsonb_array_elements(p_departments) loop
    insert into public.departments (organisation_id, slug, name, description, accent, sort_order)
    values (v_org, v_dep ->> 'slug', v_dep ->> 'name', coalesce(v_dep ->> 'description', ''),
            coalesce(v_dep ->> 'accent', 'slate'), coalesce((v_dep ->> 'sortOrder')::int, 0));
  end loop;

  for v_ag in select * from jsonb_array_elements(p_agents) loop
    select id into v_dep_id from public.departments
     where organisation_id = v_org and slug = v_ag ->> 'department';
    if v_dep_id is null then
      raise exception 'Unknown department % for agent %', v_ag ->> 'department', v_ag ->> 'slug';
    end if;
    insert into public.agents (
      organisation_id, department_id, slug, display_name, role_title, description,
      responsibilities, allowed_tools, model_tier, max_concurrent_tasks, escalation_policy
    ) values (
      v_org, v_dep_id, v_ag ->> 'slug', v_ag ->> 'displayName', v_ag ->> 'roleTitle',
      coalesce(v_ag ->> 'description', ''),
      coalesce(array(select jsonb_array_elements_text(v_ag -> 'responsibilities')), '{}'),
      coalesce(array(select jsonb_array_elements_text(v_ag -> 'allowedTools')), '{}'),
      (v_ag ->> 'modelTier')::public.cost_tier,
      coalesce((v_ag ->> 'maxConcurrentTasks')::int, 1),
      coalesce(v_ag -> 'escalationPolicy', '{}'::jsonb)
    ) returning id into v_agent_id;

    for v_cat in select jsonb_array_elements_text(coalesce(v_ag -> 'dataCategories', '[]'::jsonb)) loop
      insert into public.agent_permissions (agent_id, organisation_id, data_category, access)
      values (v_agent_id, v_org, v_cat::public.data_category, 'READ');
    end loop;
  end loop;

  perform private.emit_event(v_org, 'ORGANISATION_CREATED', format('Organisation "%s" created', p_name),
    jsonb_build_object('agents', jsonb_array_length(p_agents), 'departments', jsonb_array_length(p_departments)));
  insert into public.audit_logs (organisation_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_org, 'user', p_user_id, 'organisation.created', 'organisation', v_org::text, jsonb_build_object('name', p_name));
  return v_org;
end;
$$;
revoke execute on function public.bootstrap_organisation(uuid, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.bootstrap_organisation(uuid, text, text, jsonb, jsonb) to service_role;

-- Realtime: the command centre subscribes to these tables. Realtime enforces
-- the same SELECT policies as the REST API.
alter publication supabase_realtime add table
  public.agents,
  public.tasks,
  public.agent_events,
  public.handoffs,
  public.approvals,
  public.tenders,
  public.workflow_runs,
  public.notifications;
