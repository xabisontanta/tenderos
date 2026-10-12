-- AI assistance settings (docs/ai-agents.md, AGENTS.md section 11).
--
-- Model-backed agent steps run for an organisation only when BOTH its own switch (system_settings.ai_enabled, below)
-- and the deployment's kill switch (AI_ENABLED=true in the worker's environment) are on. Both start off.
--
--   * ai_enabled / ai_web_research_enabled are the exact columns the engine already reads.
--   * set_ai_settings and set_ai_budget are the only way to change them (owners and admins; privileged, so they ask for
--     a second factor when the organisation requires one; rate limited; audited). Switching AI on is refused while the
--     daily AI budget is zero, because the engine reads a zero budget as "no limit" and AI must never run unlimited.
--     Two constraints keep the same rules true however the row is written.
--   * ai_spend gives the settings screen today's and this month's AI spend, summed in the database (South African
--     calendar day and month), never added up in the browser.

alter table public.system_settings
  add column ai_enabled boolean not null default false,
  add column ai_web_research_enabled boolean not null default false,
  add constraint system_settings_ai_needs_budget check (not ai_enabled or daily_ai_budget_usd > 0),
  add constraint system_settings_web_research_needs_ai check (not ai_web_research_enabled or ai_enabled);

create or replace function public.set_ai_settings(p_org uuid, p_enabled boolean, p_web_research boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was public.system_settings;
begin
  perform public.hit_rate_limit('settings.ai', 20, 3600);
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only an owner or admin can change AI assistance' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  if p_enabled is null or p_web_research is null then
    raise exception 'Choose on or off' using errcode = 'check_violation';
  end if;
  if p_web_research and not p_enabled then
    raise exception 'Web research needs AI assistance to be on' using errcode = 'check_violation';
  end if;

  select * into v_was from public.system_settings s where s.organisation_id = p_org for update;
  if v_was.organisation_id is null then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  if p_enabled and v_was.daily_ai_budget_usd <= 0 then
    raise exception 'Set a daily AI budget above zero before switching AI on' using errcode = 'check_violation';
  end if;
  if v_was.ai_enabled = p_enabled and v_was.ai_web_research_enabled = p_web_research then
    return;
  end if;

  update public.system_settings
     set ai_enabled = p_enabled, ai_web_research_enabled = p_web_research, updated_by = auth.uid()
   where organisation_id = p_org;

  perform private.write_audit(p_org,
    case when p_enabled and not v_was.ai_enabled then 'settings.ai_enabled'
         when not p_enabled and v_was.ai_enabled then 'settings.ai_disabled'
         else 'settings.ai_updated' end,
    'system_settings', p_org::text,
    jsonb_build_object('ai_enabled', p_enabled, 'web_research', p_web_research, 'daily_budget_usd', v_was.daily_ai_budget_usd,
                       'was_enabled', v_was.ai_enabled, 'was_web_research', v_was.ai_web_research_enabled));
  perform private.notify_members(p_org, 'AI_SETTINGS_CHANGED', case when p_enabled then 'WARNING' else 'INFO' end::public.event_severity,
    case when p_enabled then 'AI assistance is on' else 'AI assistance is off' end,
    case when p_enabled then 'Tender text and documents, a short list of company facts and draft proposal text are now sent to Anthropic to help prepare bids. Director personal data, bank details and proof of address never are.'
         else 'No tender text, documents or company facts are sent to Anthropic. Bids are prepared with rules only.' end,
    '/settings#ai',
    array['owner', 'admin', 'operator', 'viewer']::public.org_role[]);
end;
$$;
revoke execute on function public.set_ai_settings(uuid, boolean, boolean) from public, anon;
grant execute on function public.set_ai_settings(uuid, boolean, boolean) to authenticated;

create or replace function public.set_ai_budget(p_org uuid, p_daily_usd numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_was numeric;
begin
  perform public.hit_rate_limit('settings.ai_budget', 30, 3600);
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only an owner or admin can change the AI budget' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  if p_daily_usd is null or p_daily_usd <= 0 then
    raise exception 'The daily AI budget must be more than zero' using errcode = 'check_violation';
  end if;
  if p_daily_usd > 1000 then
    raise exception 'The daily AI budget cannot be more than $1000' using errcode = 'check_violation';
  end if;
  if p_daily_usd <> round(p_daily_usd, 2) then
    raise exception 'Use dollars and cents for the AI budget' using errcode = 'check_violation';
  end if;

  select s.daily_ai_budget_usd into v_was from public.system_settings s where s.organisation_id = p_org for update;
  if not found then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  if v_was = p_daily_usd then
    return;
  end if;
  update public.system_settings set daily_ai_budget_usd = p_daily_usd, updated_by = auth.uid() where organisation_id = p_org;
  perform private.write_audit(p_org, 'settings.ai_budget_changed', 'system_settings', p_org::text,
    jsonb_build_object('daily_budget_usd', p_daily_usd, 'was_daily_budget_usd', v_was));
end;
$$;
revoke execute on function public.set_ai_budget(uuid, numeric) from public, anon;
grant execute on function public.set_ai_budget(uuid, numeric) to authenticated;

-- Spend so far today and this month, in US dollars, for a member of the organisation. Days and months are South African.
-- Simulated work costs nothing and is left out.
create or replace function public.ai_spend(p_org uuid)
returns table (today_usd numeric, month_usd numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamp := now() at time zone 'Africa/Johannesburg';
begin
  if not private.is_org_member(p_org) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  return query
    select coalesce(sum(u.cost_usd) filter (where u.created_at >= date_trunc('day', v_now) at time zone 'Africa/Johannesburg'), 0)::numeric,
           coalesce(sum(u.cost_usd), 0)::numeric
      from public.cost_usage u
     where u.organisation_id = p_org and not u.is_simulated
       and u.created_at >= date_trunc('month', v_now) at time zone 'Africa/Johannesburg';
end;
$$;
revoke execute on function public.ai_spend(uuid) from public, anon;
grant execute on function public.ai_spend(uuid) to authenticated;
