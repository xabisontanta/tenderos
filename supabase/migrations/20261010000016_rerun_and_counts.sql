-- Recovery after a rejected approval or a failed QA review, and dashboard
-- counts computed in the database.

-- ---------------------------------------------------------------------------
-- 1. A bid sent back by the approver (PREPARING_BID) or failed by QA
--    (QA_FAILED) can be prepared again, starting with a fresh compliance
--    check. Mirrors TENDER_TRANSITIONS in lib/domain/tender-state.ts.
-- ---------------------------------------------------------------------------
create or replace function private.tender_transition_allowed(p_from public.tender_status, p_to public.tender_status)
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
    when 'PREPARING_BID' then p_to in ('PRICING', 'QUALITY_ASSURANCE', 'CLARIFICATION', 'COMPLIANCE_REVIEW', 'CANCELLED')
    when 'PRICING' then p_to in ('QUALITY_ASSURANCE', 'PREPARING_BID', 'CANCELLED')
    when 'QUALITY_ASSURANCE' then p_to in ('READY_FOR_APPROVAL', 'QA_FAILED', 'CANCELLED')
    when 'QA_FAILED' then p_to in ('PREPARING_BID', 'PRICING', 'COMPLIANCE_REVIEW', 'CANCELLED')
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

-- Starts a new run of the same workflow at the compliance step. The earlier
-- run's analysis and qualification are reused (the engine reads them through
-- options.resume_from); a run still blocked at QA is closed first.
create or replace function public.rerun_bid(p_tender_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_s public.system_settings;
  v_prev public.workflow_runs;
  v_run uuid;
  v_corr uuid := gen_random_uuid();
begin
  select * into v_t from public.tenders where id = p_tender_id for update;
  if not found or not private.has_org_role(v_t.organisation_id, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Tender not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('workflow.start', 20, 60);
  if v_t.status not in ('PREPARING_BID', 'QA_FAILED') then
    raise exception 'Only a bid sent back by the approver or failed by QA can be prepared again (tender is %)', v_t.status
      using errcode = 'check_violation';
  end if;
  if v_t.closing_at <= now() then
    raise exception 'The closing date has passed' using errcode = 'check_violation';
  end if;
  select * into v_s from public.system_settings where organisation_id = v_t.organisation_id;
  if v_s.kill_switch then
    raise exception 'The emergency kill switch is engaged; workflows cannot start' using errcode = 'check_violation';
  end if;

  select * into v_prev from public.workflow_runs where tender_id = v_t.id order by created_at desc limit 1 for update;
  if v_prev.id is null then
    raise exception 'This tender has no earlier run to continue from' using errcode = 'check_violation';
  end if;
  if v_prev.status in ('PENDING', 'RUNNING', 'WAITING_APPROVAL') then
    raise exception 'A workflow is still running for this tender' using errcode = 'check_violation';
  end if;
  if v_prev.status = 'BLOCKED' then
    update public.workflow_runs set status = 'CANCELLED', outcome = 'RERUN', completed_at = now() where id = v_prev.id;
    update public.tasks set status = 'CANCELLED', blocked_reason = 'Bid prepared again'
     where workflow_run_id = v_prev.id and status in ('QUEUED', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'FAILED');
  end if;

  insert into public.workflow_runs (organisation_id, tender_id, workflow_key, status, is_simulation, options,
                                    correlation_id, max_tasks, started_by)
  values (v_t.organisation_id, v_t.id, v_prev.workflow_key, 'PENDING', v_prev.is_simulation,
          jsonb_build_object('start_step', 'compliance', 'resume_from', v_prev.id),
          v_corr, v_s.max_tasks_per_workflow, auth.uid())
  returning id into v_run;

  perform private.enqueue_job(v_t.organisation_id, 'workflow.start', jsonb_build_object('workflow_run_id', v_run), 'workflow.start:' || v_run);
  perform private.emit_event(v_t.organisation_id, 'WORKFLOW_REQUESTED',
    format('Bid preparation restarted for "%s"', left(v_t.title, 200)),
    jsonb_build_object('workflow_key', v_prev.workflow_key, 'resume_from', v_prev.id), 'INFO', null, v_t.id, null, v_run, null, null, v_corr);
  perform private.write_audit(v_t.organisation_id, 'workflow.rerun', 'workflow_run', v_run::text,
    jsonb_build_object('tender_id', v_t.id, 'resume_from', v_prev.id), v_corr);
  return v_run;
end;
$$;
revoke execute on function public.rerun_bid(uuid) from public, anon;
grant execute on function public.rerun_bid(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Dashboard counts in one query, under the caller's RLS. The old code
--    counted rows in the browser and stopped at the API's 1000-row limit.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_counts(p_org uuid, p_day_start timestamptz, p_month_start timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'tenders', coalesce((select jsonb_object_agg(s.status, s.n)
                           from (select status::text as status, count(*) as n from public.tenders
                                  where organisation_id = p_org group by status) s), '{}'::jsonb),
    'cost_today', coalesce((select sum(cost_usd) from public.cost_usage where organisation_id = p_org and created_at >= p_day_start), 0),
    'cost_month', coalesce((select sum(cost_usd) from public.cost_usage where organisation_id = p_org and created_at >= p_month_start), 0));
$$;
revoke execute on function public.dashboard_counts(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_counts(uuid, timestamptz, timestamptz) to authenticated;
