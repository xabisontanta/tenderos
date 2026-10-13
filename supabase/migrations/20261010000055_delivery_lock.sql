-- Delivery details are locked once a bid goes for approval (docs/production-readiness.md, P0 #11).
--
-- An operator could change submission_destination, submission_method, source_url and closing_at after an
-- owner or admin approved a bid, quietly redirecting it (found independently by two reviewers). Now, while a
-- bid is READY_FOR_APPROVAL, APPROVED, SUBMITTING or SUBMITTED, or has a PENDING or APPROVED approval:
--
--   * a trigger refuses changes to those four columns from every session, whatever the role;
--   * the only exception is a closing date moved by the system (the portal extended the tender), which
--     discovery follows, moving a pending approval's expiry with it;
--   * owners and admins change them with change_tender_delivery, which withdraws the approval: it cancels the
--     approval and the run, marks an undelivered submission FAILED, sends the tender back to PREPARING_BID
--     (through the transitions the state machine allows, each on record), applies the change, and audits who
--     changed what and why. The bid is then prepared again (rerun_bid) and approved afresh.
--   * a bid that was already delivered is a record: its details cannot be changed at all.

create or replace function private.delivery_locked(p_tender uuid, p_status public.tender_status)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_status in ('READY_FOR_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMITTED')
      or exists (select 1 from public.approvals a where a.tender_id = p_tender and a.status in ('PENDING', 'APPROVED'));
$$;

create or replace function private.guard_delivery_details()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Set only by public.change_tender_delivery, for its own transaction.
  if current_setting('app.delivery_change', true) = 'on' then
    return new;
  end if;
  if not private.delivery_locked(old.id, old.status) then
    return new;
  end if;
  if new.submission_destination is distinct from old.submission_destination
     or new.submission_method is distinct from old.submission_method
     or new.source_url is distinct from old.source_url
     -- A signed-in person may not move the closing time; the system may (the portal extended it).
     or (new.closing_at is distinct from old.closing_at and auth.uid() is not null) then
    raise exception 'Delivery details are locked while a bid is waiting for approval or delivery. An owner or admin can change them with "Change delivery details", which withdraws the approval.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger tenders_guard_delivery
  before update of submission_destination, submission_method, source_url, closing_at on public.tenders
  for each row execute function private.guard_delivery_details();

-- ---------------------------------------------------------------------------
-- The path for owners and admins
-- ---------------------------------------------------------------------------
create or replace function public.change_tender_delivery(p_tender_id uuid, p_changes jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_t public.tenders;
  v_key text;
  v_reason text := trim(p_reason);
  v_dest text;
  v_method public.submission_method;
  v_closing timestamptz;
  v_url text;
  v_changes jsonb := '{}'::jsonb;
  v_locked boolean;
  v_status public.tender_status;
  v_next public.tender_status;
  v_run record;
  v_cancelled integer := 0;
begin
  select * into v_t from public.tenders where id = p_tender_id for update;
  if not found or not private.has_org_role(v_t.organisation_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Tender not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('tender.delivery_change', 10, 3600);
  if v_reason is null or char_length(v_reason) < 3 then
    raise exception 'A reason is required' using errcode = 'check_violation';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'Nothing to change' using errcode = 'check_violation';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('submission_destination', 'submission_method', 'closing_at', 'source_url') then
      raise exception '% cannot be changed here', v_key using errcode = 'check_violation';
    end if;
  end loop;

  v_dest := case when p_changes ? 'submission_destination' then nullif(trim(p_changes ->> 'submission_destination'), '') else v_t.submission_destination end;
  v_method := case when p_changes ? 'submission_method' then (p_changes ->> 'submission_method')::public.submission_method else v_t.submission_method end;
  v_closing := case when p_changes ? 'closing_at' then (p_changes ->> 'closing_at')::timestamptz else v_t.closing_at end;
  v_url := case when p_changes ? 'source_url' then nullif(trim(p_changes ->> 'source_url'), '') else v_t.source_url end;
  if v_method is null or v_closing is null then
    raise exception 'The submission method and the closing time cannot be cleared' using errcode = 'check_violation';
  end if;
  if char_length(v_dest) > 500 then
    raise exception 'The destination is too long (500 characters at most)' using errcode = 'check_violation';
  end if;
  if v_url is not null and v_url !~ '^https?://' then
    raise exception 'The source link must start with http:// or https://' using errcode = 'check_violation';
  end if;
  if v_closing is distinct from v_t.closing_at and v_closing <= now() then
    raise exception 'The closing time must be in the future' using errcode = 'check_violation';
  end if;

  if v_dest is distinct from v_t.submission_destination then
    v_changes := v_changes || jsonb_build_object('submission_destination', jsonb_build_object('from', v_t.submission_destination, 'to', v_dest));
  end if;
  if v_method is distinct from v_t.submission_method then
    v_changes := v_changes || jsonb_build_object('submission_method', jsonb_build_object('from', v_t.submission_method, 'to', v_method));
  end if;
  if v_closing is distinct from v_t.closing_at then
    v_changes := v_changes || jsonb_build_object('closing_at', jsonb_build_object('from', v_t.closing_at, 'to', v_closing));
  end if;
  if v_url is distinct from v_t.source_url then
    v_changes := v_changes || jsonb_build_object('source_url', jsonb_build_object('from', v_t.source_url, 'to', v_url));
  end if;
  if v_changes = '{}'::jsonb then
    raise exception 'Nothing to change' using errcode = 'check_violation';
  end if;

  v_locked := private.delivery_locked(v_t.id, v_t.status);
  v_status := v_t.status;
  if v_locked then
    if v_status not in ('READY_FOR_APPROVAL', 'APPROVED', 'SUBMITTING', 'SUBMISSION_FAILED') then
      raise exception 'This bid has already been delivered or closed; its delivery details are a record and cannot be changed' using errcode = 'check_violation';
    end if;

    -- Withdraw: the approval no longer matches the bid, so it ends here and the bid is approved afresh.
    update public.approvals
       set status = 'CANCELLED', comments = 'Withdrawn because the delivery details changed'
     where tender_id = v_t.id and status in ('PENDING', 'APPROVED');
    get diagnostics v_cancelled = row_count;

    for v_run in select r.id from public.workflow_runs r
                  where r.tender_id = v_t.id and r.status in ('PENDING', 'RUNNING', 'WAITING_APPROVAL', 'BLOCKED') loop
      update public.workflow_runs
         set status = 'CANCELLED', outcome = 'DELIVERY_CHANGED', error = 'Delivery details changed', completed_at = now()
       where id = v_run.id;
      update public.tasks set status = 'CANCELLED', blocked_reason = 'Delivery details changed'
       where workflow_run_id = v_run.id and status in ('QUEUED', 'WAITING', 'BLOCKED', 'NEEDS_APPROVAL', 'FAILED');
      update public.handoffs set status = 'CANCELLED' where workflow_run_id = v_run.id and status = 'PENDING';
      perform private.enqueue_job(v_t.organisation_id, 'agents.refresh', jsonb_build_object('workflow_run_id', v_run.id));
    end loop;

    -- A pack nobody has delivered yet must not be delivered to the new address.
    update public.submission_records
       set status = 'FAILED', receipt = receipt || jsonb_build_object('withdrawn', true, 'withdrawn_reason', 'Delivery details changed')
     where tender_id = v_t.id and status in ('ACTION_REQUIRED', 'PREPARING');

    -- Back to preparation through the transitions the state machine allows, each one on the record.
    perform set_config('app.transition_reason', left('Delivery details changed: ' || v_reason, 500), true);
    while v_status <> 'PREPARING_BID' loop
      v_next := case v_status
        when 'READY_FOR_APPROVAL' then 'PREPARING_BID'::public.tender_status
        when 'APPROVED' then 'SUBMITTING'::public.tender_status
        when 'SUBMITTING' then 'SUBMISSION_FAILED'::public.tender_status
        when 'SUBMISSION_FAILED' then 'READY_FOR_APPROVAL'::public.tender_status
      end;
      if v_next is null then
        raise exception 'Cannot withdraw a bid in state %', v_status using errcode = 'check_violation';
      end if;
      update public.tenders set status = v_next where id = v_t.id;
      v_status := v_next;
    end loop;
  end if;

  perform set_config('app.delivery_change', 'on', true);
  update public.tenders
     set submission_destination = v_dest, submission_method = v_method, closing_at = v_closing, source_url = v_url
   where id = v_t.id;
  perform set_config('app.delivery_change', 'off', true);

  perform private.write_audit(v_t.organisation_id, 'tender.delivery_changed', 'tender', v_t.id::text,
    jsonb_build_object('reason', v_reason, 'changes', v_changes, 'withdrew_approval', v_cancelled > 0, 'sent_back_for_preparation', v_locked));
  perform private.emit_event(v_t.organisation_id, 'TENDER_DELIVERY_CHANGED',
    format('Delivery details changed on "%s"%s', left(v_t.title, 200),
           case when v_locked then ': the approval was withdrawn and the bid sent back for preparation' else '' end),
    jsonb_build_object('fields', (select jsonb_agg(k) from jsonb_object_keys(v_changes) k), 'withdrew_approval', v_cancelled > 0),
    'WARNING', null, v_t.id);
  if v_locked then
    perform private.notify_members(v_t.organisation_id, 'DELIVERY_CHANGED', 'WARNING', 'Delivery details changed',
      format('The approval for "%s" was withdrawn because its delivery details changed. Prepare the bid again for a fresh approval.', left(v_t.title, 200)),
      '/tenders/' || v_t.id::text);
  end if;

  return jsonb_build_object('withdrawn', v_locked, 'approvals_cancelled', v_cancelled, 'status', v_status);
end;
$$;

revoke all on function private.delivery_locked(uuid, public.tender_status) from public, anon, authenticated;
revoke all on function private.guard_delivery_details() from public, anon, authenticated;
revoke execute on function public.change_tender_delivery(uuid, jsonb, text) from public, anon;
grant execute on function public.change_tender_delivery(uuid, jsonb, text) to authenticated;
