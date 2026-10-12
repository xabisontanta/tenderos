-- Optional enforcement of a second factor (aal2), per organisation.
--
-- An owner can switch on "Require MFA for everyone" (system_settings.require_mfa, off by default). While it is on,
-- every privileged function below refuses a session that has not passed an authenticator challenge: the JWT's `aal`
-- claim is not `aal2`. The refusal is SQLSTATE P0403, which the app turns into "Verify with your authenticator" with a
-- link to /mfa.
--
--   * private.require_aal2(org) raises when the organisation requires MFA and the session is below aal2. It does nothing
--     when there is no signed-in user (auth.uid() is null: the worker, the service role), so background work is unaffected.
--   * set_require_mfa is for owners, and the caller must be at aal2 now, in both directions. An owner who has not
--     enrolled cannot switch it on, so nobody is locked out by the person who turned it on, and an aal1 session (a stolen
--     password) cannot switch it off. Switching it on also revokes browser pairing codes made below aal2
--     (autofill_tokens.created_aal; a pairing made before this column existed counts as below aal2).
--   * Each function below is re-created whole from its migrated definition (pg_get_functiondef) with one added line,
--     `perform private.require_aal2(<organisation>)`, after its role check (so the answer is not given to people who
--     could not call it anyway) and before anything else happens. The rate-limit lines each one already has are kept.
--   * Reading the restricted document categories (director IDs, bank letters, proof of address) is also gated, in
--     private.can_read_document, which the Storage read policy and document_download both use.
--   * has_org_role keeps its signature. Members who have not set up an authenticator can still sign in and read; they
--     cannot do what is listed here until they do (Settings, Security).
--
-- The tests: tests/integration/aal2.test.ts (every function, with claims set as PostgREST sets them) and the catalogue
-- test in tests/integration/hardening.test.ts, which fails if any listed function loses its `require_aal2(` line.

alter table public.system_settings add column require_mfa boolean not null default false;
alter table public.autofill_tokens add column created_aal text check (created_aal is null or created_aal in ('aal1', 'aal2'));

-- True when nothing here needs a second factor: no signed-in user, an organisation that does not require it, or a
-- session that already has it.
create or replace function private.aal2_ok(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is null
      or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from public.system_settings s where s.organisation_id = p_org and s.require_mfa);
$$;

create or replace function private.require_aal2(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.aal2_ok(p_org) then
    raise exception 'Verify with your authenticator to do this.' using errcode = 'P0403';
  end if;
end;
$$;
revoke all on function private.aal2_ok(uuid) from public, anon, authenticated;
revoke all on function private.require_aal2(uuid) from public, anon, authenticated;
grant execute on function private.aal2_ok(uuid) to authenticated, service_role;
grant execute on function private.require_aal2(uuid) to authenticated, service_role;

-- Director IDs, bank letters and proof of address: owners and admins only (migration 014), and, when the organisation
-- requires MFA, only from a session that passed the challenge.
create or replace function private.can_read_document(p_org uuid, p_category public.data_category)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_org_member(p_org)
     and (p_category not in ('DIRECTOR_PERSONAL', 'BANKING', 'PROOF_OF_ADDRESS')
          or (private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) and private.aal2_ok(p_org)));
$$;

-- The owner's switch.
create or replace function public.set_require_mfa(p_org uuid, p_on boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revoked integer := 0;
begin
  perform public.hit_rate_limit('settings.require_mfa', 10, 3600);
  if not private.has_org_role(p_org, array['owner']::public.org_role[]) then
    raise exception 'Only an owner can change whether everyone must use an authenticator' using errcode = 'insufficient_privilege';
  end if;
  if p_on is null then
    raise exception 'Choose on or off' using errcode = 'check_violation';
  end if;
  -- Always from a session that has passed the challenge, so an owner without an authenticator cannot lock the
  -- organisation out, and a password alone cannot switch the protection off.
  if coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'Verify with your authenticator to do this.' using errcode = 'P0403';
  end if;

  perform 1 from public.system_settings s where s.organisation_id = p_org for update;
  update public.system_settings set require_mfa = p_on, updated_by = auth.uid() where organisation_id = p_org;
  if p_on then
    update public.autofill_tokens t set revoked_at = now()
     where t.organisation_id = p_org and t.revoked_at is null and t.created_aal is distinct from 'aal2';
    get diagnostics v_revoked = row_count;
  end if;
  perform private.write_audit(p_org, case when p_on then 'settings.require_mfa_on' else 'settings.require_mfa_off' end,
    'system_settings', p_org::text, jsonb_build_object('pairing_codes_revoked', v_revoked));
  perform private.notify_members(p_org, case when p_on then 'MFA_REQUIRED' else 'MFA_NOT_REQUIRED' end, 'WARNING',
    case when p_on then 'An authenticator is now required' else 'An authenticator is no longer required' end,
    case when p_on then 'Your organisation now asks everyone to verify with an authenticator app before approving, sending, changing settings or opening documents. Set one up in Settings, Security.'
         else 'Your organisation no longer requires an authenticator app for approving, sending and changing settings.' end,
    '/settings#security',
    array['owner', 'admin', 'operator', 'viewer']::public.org_role[]);
end;
$$;
revoke execute on function public.set_require_mfa(uuid, boolean) from public, anon;
grant execute on function public.set_require_mfa(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- The privileged functions, each with `perform private.require_aal2(...)` after its role check
-- ---------------------------------------------------------------------------
-- set_kill_switch
CREATE OR REPLACE FUNCTION public.set_kill_switch(p_org uuid, p_engaged boolean, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('settings.kill_switch', 10, 60);
  end if;
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
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
$function$
;

-- set_agent_control
CREATE OR REPLACE FUNCTION public.set_agent_control(p_agent_id uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS agent_status
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ag public.agents;
  v_to public.agent_status;
  v_active int;
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('agent.control', 20, 60);
  end if;
  select * into v_ag from public.agents where id = p_agent_id for update;
  if not found or not private.has_org_role(v_ag.organisation_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Agent not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_ag.organisation_id);

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
$function$
;

-- decide_approval
CREATE OR REPLACE FUNCTION public.decide_approval(p_approval_id uuid, p_approve boolean, p_comments text DEFAULT NULL::text)
 RETURNS approval_status
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_a public.approvals;
  v_status public.approval_status;
  v_corr uuid;
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('approval.decide', 30, 60);
  end if;
  select * into v_a from public.approvals where id = p_approval_id for update;
  if not found or not private.has_org_role(v_a.organisation_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Approval not found or not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_a.organisation_id);
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
$function$
;

-- set_watched_provinces
CREATE OR REPLACE FUNCTION public.set_watched_provinces(p_org uuid, p_provinces text[], p_auto_run boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('settings.update', 30, 60);
  end if;
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can change watched provinces' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
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
$function$
;

-- set_watched_methods
CREATE OR REPLACE FUNCTION public.set_watched_methods(p_org uuid, p_methods text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('settings.update', 30, 60);
  end if;
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can change delivery methods' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
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
$function$
;

-- register_company_document
CREATE OR REPLACE FUNCTION public.register_company_document(p_org uuid, p_doc_type text, p_title text, p_path text, p_expires_at date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_obj record;
  v_admin boolean;
  v_id uuid;
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('document.register', 60, 3600);
  end if;
  if not private.has_org_role(p_org, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  if p_path is null or split_part(p_path, '/', 1) <> p_org::text or p_path like '%..%' then
    raise exception 'Invalid document path' using errcode = 'check_violation';
  end if;
  select name, metadata into v_obj from storage.objects where bucket_id = 'company-documents' and name = p_path;
  if not found then
    raise exception 'Upload the file before registering it' using errcode = 'check_violation';
  end if;
  v_admin := private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]);
  insert into public.company_documents (organisation_id, doc_type, data_category, title, file_name, storage_path,
                                        mime_type, size_bytes, expires_at, verified, verified_by, verified_at, uploaded_by)
  values (p_org, p_doc_type, private.document_category(p_doc_type), trim(p_title),
          left(regexp_replace(p_path, '^.*/', ''), 255), p_path,
          v_obj.metadata ->> 'mimetype', nullif(v_obj.metadata ->> 'size', '')::bigint, p_expires_at,
          v_admin, case when v_admin then auth.uid() end, case when v_admin then now() end, auth.uid())
  returning id into v_id;
  perform private.write_audit(p_org, 'document.uploaded', 'company_document', v_id::text,
    jsonb_build_object('doc_type', p_doc_type, 'verified', v_admin));
  perform private.emit_event(p_org, 'DOCUMENT_UPLOADED', format('Document added: %s', left(trim(p_title), 200)),
    jsonb_build_object('document_id', v_id, 'doc_type', p_doc_type, 'verified', v_admin));
  return v_id;
end;
$function$
;

-- verify_company_document
CREATE OR REPLACE FUNCTION public.verify_company_document(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid;
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('document.manage', 120, 3600);
  end if;
  select organisation_id into v_org from public.company_documents where id = p_id and archived_at is null;
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can verify documents' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_org);
  update public.company_documents set verified = true, verified_by = auth.uid(), verified_at = now() where id = p_id;
  perform private.write_audit(v_org, 'document.verified', 'company_document', p_id::text, '{}'::jsonb);
end;
$function$
;

-- archive_company_document
CREATE OR REPLACE FUNCTION public.archive_company_document(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid;
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('document.manage', 120, 3600);
  end if;
  select organisation_id into v_org from public.company_documents where id = p_id and archived_at is null;
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can remove documents' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_org);
  update public.company_documents set archived_at = now() where id = p_id;
  perform private.write_audit(v_org, 'document.archived', 'company_document', p_id::text, '{}'::jsonb);
end;
$function$
;

-- document_download
CREATE OR REPLACE FUNCTION public.document_download(p_id uuid)
 RETURNS TABLE(storage_path text, file_name text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_doc public.company_documents;
begin
  select * into v_doc from public.company_documents d where d.id = p_id and d.archived_at is null;
  if v_doc.id is null or not private.can_read_document(v_doc.organisation_id, v_doc.data_category) then
    raise exception 'Document not found' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_doc.organisation_id);
  perform public.hit_rate_limit('document.download', 120, 3600);
  perform private.write_audit(v_doc.organisation_id, 'document.downloaded', 'company_document', v_doc.id::text,
    jsonb_build_object('doc_type', v_doc.doc_type));
  return query select v_doc.storage_path, v_doc.file_name;
end;
$function$
;

-- connect_email_account
CREATE OR REPLACE FUNCTION public.connect_email_account(p_org uuid, p_provider email_provider, p_from text, p_display_name text, p_secret text, p_smtp_host text DEFAULT NULL::text, p_smtp_port integer DEFAULT NULL::integer, p_smtp_username text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_secret uuid;
  v_id uuid;
begin
  -- Only owners and admins deliver bids, so only they connect a sending mailbox.
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can connect a mailbox' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  perform public.hit_rate_limit('email.connect', 10, 3600);
  if p_secret is null or char_length(p_secret) not between 8 and 4096 then
    raise exception 'Missing mailbox credentials' using errcode = 'check_violation';
  end if;
  -- Reconnecting the same address replaces the old credentials.
  perform public.disconnect_email_account(id) from public.email_accounts
   where organisation_id = p_org and user_id = auth.uid() and lower(from_address) = lower(trim(p_from)) and revoked_at is null;
  v_secret := vault.create_secret(p_secret, 'tenderos_email_' || gen_random_uuid()::text, 'TenderOS mailbox credential');
  insert into public.email_accounts (organisation_id, user_id, provider, from_address, display_name,
                                     smtp_host, smtp_port, smtp_username, secret_id)
  values (p_org, auth.uid(), p_provider, lower(trim(p_from)), nullif(trim(p_display_name), ''),
          lower(nullif(trim(p_smtp_host), '')), p_smtp_port, nullif(trim(p_smtp_username), ''), v_secret)
  returning id into v_id;
  perform private.write_audit(p_org, 'email.connected', 'email_account', v_id::text,
    jsonb_build_object('provider', p_provider, 'from', lower(trim(p_from))));
  return v_id;
end;
$function$
;

-- disconnect_email_account
CREATE OR REPLACE FUNCTION public.disconnect_email_account(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_acc public.email_accounts;
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('email.disconnect', 20, 3600);
  end if;
  select * into v_acc from public.email_accounts where id = p_id and revoked_at is null for update;
  if v_acc.id is null
     or not (v_acc.user_id = auth.uid() or private.has_org_role(v_acc.organisation_id, array['owner', 'admin']::public.org_role[])) then
    raise exception 'Mailbox not found' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_acc.organisation_id);
  update public.email_accounts set revoked_at = now() where id = p_id;
  delete from vault.secrets where id = v_acc.secret_id;
  perform private.write_audit(v_acc.organisation_id, 'email.disconnected', 'email_account', p_id::text, '{}'::jsonb);
end;
$function$
;

-- record_bid_delivery
CREATE OR REPLACE FUNCTION public.record_bid_delivery(p_submission_id uuid, p_reference text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_sub public.submission_records;
  v_status public.tender_status;
begin
  select * into v_sub from public.submission_records where id = p_submission_id for update;
  if v_sub.id is null or not private.has_org_role(v_sub.organisation_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can record a bid delivery' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_sub.organisation_id);
  perform public.hit_rate_limit('bid.record_delivery', 20, 3600);
  if v_sub.is_simulation then
    raise exception 'Simulated submissions cannot be recorded as delivered' using errcode = 'check_violation';
  end if;
  if v_sub.status <> 'ACTION_REQUIRED' then
    raise exception 'This bid is already recorded as %', lower(v_sub.status::text) using errcode = 'check_violation';
  end if;
  update public.submission_records
     set status = 'SUBMITTED', submitted_at = now(),
         external_reference = nullif(left(trim(p_reference), 200), ''),
         receipt = receipt || jsonb_build_object('delivered_by', auth.uid(), 'delivery_note', nullif(left(trim(p_note), 1000), ''))
   where id = v_sub.id;
  select status into v_status from public.tenders where id = v_sub.tender_id for update;
  if v_status = 'SUBMITTING' then
    perform set_config('app.transition_reason', 'Bid delivered and recorded by a person', true);
    update public.tenders set status = 'SUBMITTED' where id = v_sub.tender_id;
  end if;
  update public.workflow_runs
     set status = 'COMPLETED', outcome = 'SUBMITTED', error = null, completed_at = now(), current_step = null
   where id = v_sub.workflow_run_id and status in ('BLOCKED', 'RUNNING');
  perform private.emit_event(v_sub.organisation_id, 'SUBMISSION_COMPLETED', 'Bid delivered and recorded',
    jsonb_build_object('submission_id', v_sub.id, 'tender_id', v_sub.tender_id, 'reference', nullif(trim(p_reference), '')));
  perform private.write_audit(v_sub.organisation_id, 'submission.delivered', 'submission_record', v_sub.id::text,
    jsonb_build_object('reference', nullif(trim(p_reference), '')));
end;
$function$
;

-- rerun_bid
CREATE OR REPLACE FUNCTION public.rerun_bid(p_tender_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  perform private.require_aal2(v_t.organisation_id);
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
$function$
;

-- change_tender_delivery
CREATE OR REPLACE FUNCTION public.change_tender_delivery(p_tender_id uuid, p_changes jsonb, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  perform private.require_aal2(v_t.organisation_id);
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
$function$
;

-- create_autofill_token
CREATE OR REPLACE FUNCTION public.create_autofill_token(p_org uuid, p_label text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_label text := coalesce(nullif(left(trim(p_label), 60), ''), 'Browser helper');
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Only owners, admins and operators can pair the browser helper' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  perform public.hit_rate_limit('autofill.token_create', 10, 3600);
  -- Serialise concurrent requests from the same member so the cap holds.
  perform 1 from public.organisation_members where organisation_id = p_org and user_id = auth.uid() for update;
  if (select count(*) from public.autofill_tokens
       where organisation_id = p_org and user_id = auth.uid() and revoked_at is null and expires_at > now()) >= 5 then
    raise exception 'You already have 5 active pairing codes; revoke one first' using errcode = 'check_violation';
  end if;
  v_token := 'tos_' || encode(extensions.gen_random_bytes(32), 'hex');
  -- The level the pairing was made at is kept, so switching on "require MFA" can revoke the ones made below aal2.
  insert into public.autofill_tokens (organisation_id, user_id, label, token_hash, created_aal)
  values (p_org, auth.uid(), v_label, encode(extensions.digest(v_token, 'sha256'), 'hex'), coalesce(auth.jwt() ->> 'aal', 'aal1'))
  returning id, expires_at into v_id, v_expires;
  perform private.write_audit(p_org, 'autofill.token_created', 'autofill_token', v_id::text,
    jsonb_build_object('label', v_label, 'expires_at', v_expires));
  return v_token;
end;
$function$
;

-- change_member_role
CREATE OR REPLACE FUNCTION public.change_member_role(p_org uuid, p_user uuid, p_role org_role)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller public.org_role;
  v_target public.org_role;
  v_mailboxes integer := 0;
  v_codes integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select m.role into v_caller from public.organisation_members m where m.organisation_id = p_org and m.user_id = auth.uid();
  if v_caller is null or v_caller not in ('owner', 'admin') then
    raise exception 'Only owners and admins can change roles' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  perform public.hit_rate_limit('member.change_role', 30, 3600);
  if p_user is null or p_role is null then
    raise exception 'Choose a member and a role' using errcode = 'check_violation';
  end if;

  -- One change at a time per organisation, owners locked in id order. The caller's role is read again
  -- under the lock: someone else's change may have taken it away while this call waited.
  perform pg_advisory_xact_lock(hashtextextended('tenderos.members:' || p_org::text, 0));
  perform 1 from public.organisation_members m where m.organisation_id = p_org and m.role = 'owner' order by m.user_id for update;
  select m.role into v_caller from public.organisation_members m where m.organisation_id = p_org and m.user_id = auth.uid();
  if v_caller is null or v_caller not in ('owner', 'admin') then
    raise exception 'Only owners and admins can change roles' using errcode = 'insufficient_privilege';
  end if;
  select m.role into v_target from public.organisation_members m where m.organisation_id = p_org and m.user_id = p_user for update;
  if v_target is null then
    raise exception 'That person is not a member of this organisation' using errcode = 'check_violation';
  end if;

  if (v_target = 'owner' or p_role = 'owner') and v_caller <> 'owner' then
    raise exception 'Only an owner can make someone an owner or change an owner''s role' using errcode = 'insufficient_privilege';
  end if;
  if p_role = 'admin' and v_target <> 'admin' and v_caller <> 'owner' then
    raise exception 'Only an owner can make someone an admin' using errcode = 'insufficient_privilege';
  end if;
  if p_role = v_target then
    return;
  end if;
  if v_target = 'owner' and not exists (
       select 1 from public.organisation_members m where m.organisation_id = p_org and m.role = 'owner' and m.user_id <> p_user) then
    raise exception 'An organisation must keep at least one owner. Make someone else an owner first.' using errcode = 'check_violation';
  end if;

  -- Only owners and admins connect a sending mailbox, so a member who drops below admin loses theirs (the
  -- credential in Vault is deleted by a trigger on the row). A viewer cannot use a browser pairing code either.
  if v_target in ('owner', 'admin') and p_role in ('operator', 'viewer') then
    with gone as (
      update public.email_accounts a set revoked_at = now()
       where a.organisation_id = p_org and a.user_id = p_user and a.revoked_at is null
      returning a.secret_id
    ), wiped as (
      delete from vault.secrets s where s.id in (select secret_id from gone) returning s.id
    )
    select count(*) into v_mailboxes from gone;
  end if;
  if p_role = 'viewer' then
    update public.autofill_tokens t set revoked_at = now()
     where t.organisation_id = p_org and t.user_id = p_user and t.revoked_at is null;
    get diagnostics v_codes = row_count;
  end if;

  update public.organisation_members m set role = p_role where m.organisation_id = p_org and m.user_id = p_user;
  perform private.write_audit(p_org, 'member.role_changed', 'member', p_user::text,
    jsonb_build_object('from', v_target, 'to', p_role, 'mailboxes_disconnected', v_mailboxes, 'pairing_codes_revoked', v_codes));
end;
$function$
;

-- remove_member
CREATE OR REPLACE FUNCTION public.remove_member(p_org uuid, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_caller public.org_role;
  v_target public.org_role;
  v_mailboxes integer;
  v_codes integer;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select m.role into v_caller from public.organisation_members m where m.organisation_id = p_org and m.user_id = auth.uid();
  if v_caller is null or (v_caller not in ('owner', 'admin') and p_user is distinct from auth.uid()) then
    raise exception 'Only owners and admins can remove members' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  perform public.hit_rate_limit('member.remove', 30, 3600);
  if p_user is null then
    raise exception 'Choose a member' using errcode = 'check_violation';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tenderos.members:' || p_org::text, 0));
  perform 1 from public.organisation_members m where m.organisation_id = p_org and m.role = 'owner' order by m.user_id for update;
  select m.role into v_caller from public.organisation_members m where m.organisation_id = p_org and m.user_id = auth.uid();
  if v_caller is null or (v_caller not in ('owner', 'admin') and p_user is distinct from auth.uid()) then
    raise exception 'Only owners and admins can remove members' using errcode = 'insufficient_privilege';
  end if;
  select m.role into v_target from public.organisation_members m where m.organisation_id = p_org and m.user_id = p_user for update;
  if v_target is null then
    raise exception 'That person is not a member of this organisation' using errcode = 'check_violation';
  end if;
  if v_target = 'owner' and v_caller <> 'owner' then
    raise exception 'Only an owner can remove an owner' using errcode = 'insufficient_privilege';
  end if;
  if v_target = 'owner' and not exists (
       select 1 from public.organisation_members m where m.organisation_id = p_org and m.role = 'owner' and m.user_id <> p_user) then
    raise exception 'An organisation must keep at least one owner. Make someone else an owner first.' using errcode = 'check_violation';
  end if;

  update public.autofill_tokens t set revoked_at = now()
   where t.organisation_id = p_org and t.user_id = p_user and t.revoked_at is null;
  get diagnostics v_codes = row_count;
  select count(*) into v_mailboxes from public.email_accounts a
   where a.organisation_id = p_org and a.user_id = p_user and a.revoked_at is null;

  -- The rows that hang off the membership go with it (pairing codes, mailboxes, and the mailbox credential in
  -- Vault by trigger); notifications stop being readable because they follow membership.
  delete from public.organisation_members m where m.organisation_id = p_org and m.user_id = p_user;
  perform private.write_audit(p_org, 'member.removed', 'member', p_user::text,
    jsonb_build_object('role', v_target, 'left', p_user = auth.uid(), 'pairing_codes_revoked', v_codes, 'mailboxes_disconnected', v_mailboxes));
end;
$function$
;

-- create_invitation
CREATE OR REPLACE FUNCTION public.create_invitation(p_org uuid, p_email text, p_role org_role)
 RETURNS TABLE(invitation_id uuid, token text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_caller public.org_role;
  v_email text := lower(trim(p_email));
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select m.role into v_caller from public.organisation_members m where m.organisation_id = p_org and m.user_id = auth.uid();
  if v_caller is null or v_caller not in ('owner', 'admin') then
    raise exception 'Only owners and admins can invite people' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(p_org);
  perform public.hit_rate_limit('invitation.create', 20, 3600);
  if p_role is null or p_role = 'owner' then
    raise exception 'An invitation cannot make someone an owner. Invite them as an admin, then make them an owner.' using errcode = 'check_violation';
  end if;
  if p_role = 'admin' and v_caller <> 'owner' then
    raise exception 'Only an owner can invite an admin' using errcode = 'insufficient_privilege';
  end if;
  if v_email is null or char_length(v_email) > 254 or v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' then
    raise exception 'Enter a valid email address' using errcode = 'check_violation';
  end if;

  -- One invitation at a time per organisation, so the cap and the one-live-invitation rule hold.
  perform pg_advisory_xact_lock(hashtextextended('tenderos.invitations:' || p_org::text, 0));
  select m.role into v_caller from public.organisation_members m where m.organisation_id = p_org and m.user_id = auth.uid();
  if v_caller is null or v_caller not in ('owner', 'admin') or (p_role = 'admin' and v_caller <> 'owner') then
    raise exception 'Only owners and admins can invite people' using errcode = 'insufficient_privilege';
  end if;

  -- Members' addresses are already visible to owners and admins (list_members); anyone else is not checked
  -- against accounts, so the answer never depends on whether an address has one.
  if exists (select 1 from public.organisation_members m join auth.users u on u.id = m.user_id
              where m.organisation_id = p_org and lower(u.email) = v_email) then
    raise exception 'That person is already a member of this organisation' using errcode = 'check_violation';
  end if;
  update public.organisation_invitations i set revoked_at = now()
   where i.organisation_id = p_org and lower(i.email) = v_email and i.accepted_at is null and i.revoked_at is null and i.expires_at <= now();
  if exists (select 1 from public.organisation_invitations i
              where i.organisation_id = p_org and lower(i.email) = v_email and i.accepted_at is null and i.revoked_at is null) then
    raise exception 'There is already a pending invitation for that address. Resend or revoke it instead.' using errcode = 'check_violation';
  end if;
  if (select count(*) from public.organisation_invitations i
       where i.organisation_id = p_org and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()) >= 50 then
    raise exception 'This organisation has 50 pending invitations. Revoke some before inviting more.' using errcode = 'check_violation';
  end if;
  perform private.limit_invitee(v_email);

  v_token := 'tinv_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.organisation_invitations (organisation_id, email, role, token_hash, invited_by)
  values (p_org, v_email, p_role, private.invitation_token_hash(v_token), auth.uid())
  returning public.organisation_invitations.id, public.organisation_invitations.expires_at into v_id, v_expires;
  perform private.write_audit(p_org, 'invitation.created', 'invitation', v_id::text, jsonb_build_object('role', p_role));
  return query select v_id, v_token, v_expires;
end;
$function$
;

-- revoke_invitation
CREATE OR REPLACE FUNCTION public.revoke_invitation(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_inv public.organisation_invitations;
  v_caller public.org_role;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_inv from public.organisation_invitations i where i.id = p_id for update;
  select m.role into v_caller from public.organisation_members m where m.organisation_id = v_inv.organisation_id and m.user_id = auth.uid();
  if v_inv.id is null or v_caller is null or v_caller not in ('owner', 'admin') or (v_inv.role = 'admin' and v_caller <> 'owner') then
    raise exception 'Invitation not found' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_inv.organisation_id);
  perform public.hit_rate_limit('invitation.revoke', 60, 3600);
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'That invitation was already used or revoked' using errcode = 'check_violation';
  end if;
  update public.organisation_invitations i set revoked_at = now() where i.id = v_inv.id;
  perform private.write_audit(v_inv.organisation_id, 'invitation.revoked', 'invitation', v_inv.id::text, jsonb_build_object('role', v_inv.role));
end;
$function$
;

-- resend_invitation
CREATE OR REPLACE FUNCTION public.resend_invitation(p_id uuid)
 RETURNS TABLE(invitation_id uuid, token text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_inv public.organisation_invitations;
  v_caller public.org_role;
  v_token text;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  select * into v_inv from public.organisation_invitations i where i.id = p_id for update;
  select m.role into v_caller from public.organisation_members m where m.organisation_id = v_inv.organisation_id and m.user_id = auth.uid();
  if v_inv.id is null or v_caller is null or v_caller not in ('owner', 'admin') or (v_inv.role = 'admin' and v_caller <> 'owner') then
    raise exception 'Invitation not found' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_inv.organisation_id);
  perform public.hit_rate_limit('invitation.resend', 20, 3600);
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'That invitation was already used or revoked. Send a new one.' using errcode = 'check_violation';
  end if;
  perform private.limit_invitee(v_inv.email);

  v_token := 'tinv_' || encode(extensions.gen_random_bytes(32), 'hex');
  update public.organisation_invitations i
     set token_hash = private.invitation_token_hash(v_token), expires_at = now() + interval '7 days'
   where i.id = v_inv.id
  returning i.expires_at into v_expires;
  perform private.write_audit(v_inv.organisation_id, 'invitation.resent', 'invitation', v_inv.id::text, jsonb_build_object('role', v_inv.role));
  return query select v_inv.id, v_token, v_expires;
end;
$function$
;
