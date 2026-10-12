-- POPIA data-subject access and organisation export.
--
-- export_user_data returns what is held about one person; export_organisation_data returns an
-- organisation's own records (portability). Both are service-role only and audit the export, naming
-- whoever asked (p_actor) when the caller knows them.
--
-- Columns are listed one by one on purpose: a column added to a table later is not exported until
-- someone decides it should be. The one exception is the company profile, every column of which is a
-- fact the organisation typed in. Never exported: Vault secrets and `secret_id`, pairing-code hashes,
-- storage paths, consent network-address hashes, file contents. Each list is capped; the `limits`
-- section says what was capped, so a truncated export never looks complete.

-- ---------------------------------------------------------------------------
-- One person
-- ---------------------------------------------------------------------------
create or replace function public.export_user_data(p_user_id uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap constant integer := 5000;
  v_org uuid;
  v_out jsonb;
begin
  if p_user_id is null then
    raise exception 'A user is required' using errcode = 'check_violation';
  end if;
  perform public.hit_rate_limit_key('export_user:' || p_user_id::text, 'popia.export', 10, 3600);
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'User not found' using errcode = 'P0002';
  end if;
  select m.organisation_id into v_org from public.organisation_members m where m.user_id = p_user_id;

  select jsonb_build_object(
    'generated_at', now(),
    'subject', (select jsonb_build_object('id', u.id, 'email', u.email, 'phone', u.phone, 'created_at', u.created_at,
                                          'email_confirmed_at', u.email_confirmed_at, 'last_sign_in_at', u.last_sign_in_at)
                  from auth.users u where u.id = p_user_id),
    'profile', (select jsonb_build_object('full_name', p.full_name, 'created_at', p.created_at, 'updated_at', p.updated_at)
                  from public.profiles p where p.id = p_user_id),
    'membership', coalesce((select jsonb_agg(jsonb_build_object('organisation_id', m.organisation_id, 'organisation_name', o.name,
                                                                'role', m.role, 'joined_at', m.created_at))
                              from public.organisation_members m join public.organisations o on o.id = m.organisation_id
                             where m.user_id = p_user_id), '[]'::jsonb),
    'consents', coalesce((select jsonb_agg(jsonb_build_object('kind', a.kind, 'version', a.version, 'accepted_at', a.accepted_at,
                                                              'network_address_recorded', a.ip_hmac is not null) order by a.accepted_at)
                            from public.legal_acceptances a where a.user_id = p_user_id), '[]'::jsonb),
    'mailboxes', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'organisation_id', a.organisation_id, 'provider', a.provider,
                                                               'from_address', a.from_address, 'display_name', a.display_name,
                                                               'smtp_host', a.smtp_host, 'smtp_port', a.smtp_port, 'smtp_username', a.smtp_username,
                                                               'status', a.status, 'last_used_at', a.last_used_at, 'created_at', a.created_at,
                                                               'revoked_at', a.revoked_at) order by a.created_at)
                             from public.email_accounts a where a.user_id = p_user_id), '[]'::jsonb),
    'browser_helper_pairings', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'created_at', t.created_at,
                                                                             'last_used_at', t.last_used_at, 'expires_at', t.expires_at,
                                                                             'revoked_at', t.revoked_at) order by t.created_at)
                                           from public.autofill_tokens t where t.user_id = p_user_id), '[]'::jsonb),
    'notifications', coalesce((select jsonb_agg(x order by x.created_at desc)
                                 from (select n.kind, n.severity, n.title, n.body, n.link, n.read_at, n.created_at
                                         from public.notifications n where n.user_id = p_user_id
                                        order by n.created_at desc limit v_cap) x), '[]'::jsonb),
    'tenders_created', coalesce((select jsonb_agg(x order by x.created_at desc)
                                   from (select t.id, t.title, t.reference_number, t.issuing_organisation, t.status, t.created_at
                                           from public.tenders t where t.created_by = p_user_id
                                          order by t.created_at desc limit v_cap) x), '[]'::jsonb),
    'documents_uploaded', coalesce((select jsonb_agg(x order by x.created_at desc)
                                      from (select d.id, d.doc_type, d.title, d.file_name, d.mime_type, d.size_bytes, d.expires_at,
                                                   d.verified, (d.uploaded_by = p_user_id) as uploaded_by_subject,
                                                   (d.verified_by = p_user_id) as verified_by_subject, d.created_at, d.archived_at
                                              from public.company_documents d
                                             where d.uploaded_by = p_user_id or d.verified_by = p_user_id
                                             order by d.created_at desc limit v_cap) x), '[]'::jsonb),
    'emails_sent', coalesce((select jsonb_agg(x order by x.created_at desc)
                               from (select e.id, e.tender_id, e.from_address, e.to_address, e.subject, e.status, e.attachments, e.created_at
                                       from public.email_messages e where e.sent_by = p_user_id
                                      order by e.created_at desc limit v_cap) x), '[]'::jsonb),
    'approvals_decided', coalesce((select jsonb_agg(x order by x.requested_at desc)
                                     from (select a.id, a.tender_id, a.type, a.status, a.comments, a.approved_at, a.rejected_at, a.requested_at
                                             from public.approvals a where a.decided_by = p_user_id
                                            order by a.requested_at desc limit v_cap) x), '[]'::jsonb),
    'audit_entries', coalesce((select jsonb_agg(x order by x.created_at desc)
                                 from (select l.id, l.organisation_id, l.action, l.resource_type, l.resource_id, l.ip, l.user_agent, l.metadata, l.created_at
                                         from public.audit_logs l where l.actor_user_id = p_user_id
                                        order by l.created_at desc limit v_cap) x), '[]'::jsonb),
    'limits', jsonb_build_object('notifications', v_cap, 'tenders_created', v_cap, 'documents_uploaded', v_cap, 'emails_sent', v_cap,
                                 'approvals_decided', v_cap, 'audit_entries', v_cap)
  ) into v_out;

  insert into public.audit_logs (organisation_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_org, 'system', p_actor, 'popia.user_exported', 'user', p_user_id::text, '{}'::jsonb);
  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- One organisation
-- ---------------------------------------------------------------------------
create or replace function public.export_organisation_data(p_org uuid, p_actor uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cap constant integer := 20000;
  v_out jsonb;
begin
  if p_org is null then
    raise exception 'An organisation is required' using errcode = 'check_violation';
  end if;
  perform public.hit_rate_limit_key('export_org:' || p_org::text, 'popia.export', 10, 3600);
  if not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'Organisation not found' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'generated_at', now(),
    'organisation', (select jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'created_at', o.created_at)
                       from public.organisations o where o.id = p_org),
    'settings', (select jsonb_build_object('simulation_mode', s.simulation_mode, 'kill_switch', s.kill_switch,
                                           'daily_ai_budget_usd', s.daily_ai_budget_usd, 'monthly_ai_budget_usd', s.monthly_ai_budget_usd,
                                           'per_tender_budget_usd', s.per_tender_budget_usd, 'audit_retention_days', s.audit_retention_days,
                                           'watched_provinces', s.watched_provinces, 'watched_methods', s.watched_methods,
                                           'auto_run_workflows', s.auto_run_workflows, 'last_discovery_at', s.last_discovery_at,
                                           'onboarding_completed_at', s.onboarding_completed_at)
                   from public.system_settings s where s.organisation_id = p_org),
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'full_name', p.full_name, 'role', m.role,
                                                             'joined_at', m.created_at) order by m.created_at)
                           from public.organisation_members m left join public.profiles p on p.id = m.user_id
                          where m.organisation_id = p_org), '[]'::jsonb),
    'company_profile', (select to_jsonb(c) - 'updated_by' from public.company_profiles c where c.organisation_id = p_org),
    'documents', coalesce((select jsonb_agg(x order by x.created_at desc)
                             from (select d.id, d.doc_type, d.title, d.file_name, d.mime_type, d.size_bytes, d.expires_at, d.verified,
                                          d.verified_at, d.created_at, d.archived_at
                                     from public.company_documents d where d.organisation_id = p_org
                                    order by d.created_at desc limit v_cap) x), '[]'::jsonb),
    'tenders', coalesce((select jsonb_agg(x order by x.created_at desc)
                           from (select t.id, t.reference_number, t.title, t.issuing_organisation, t.description, t.province, t.sector,
                                        t.estimated_value_zar, t.published_at, t.closing_at, t.briefing_at, t.briefing_compulsory,
                                        t.briefing_location, t.questions_deadline_at, t.submission_method, t.submission_destination,
                                        t.source_url, t.source_ref, t.documents, t.status, t.is_simulation, t.created_by, t.created_at
                                   from public.tenders t where t.organisation_id = p_org
                                  order by t.created_at desc limit v_cap) x), '[]'::jsonb),
    'status_history', coalesce((select jsonb_agg(x order by x.created_at desc)
                                  from (select h.tender_id, h.from_status, h.to_status, h.reason, h.actor_type, h.actor_user_id, h.created_at
                                          from public.tender_status_history h where h.organisation_id = p_org
                                         order by h.created_at desc limit v_cap) x), '[]'::jsonb),
    'workflow_runs', coalesce((select jsonb_agg(x order by x.created_at desc)
                                 from (select r.id, r.tender_id, r.workflow_key, r.status, r.outcome, r.is_simulation, r.started_by, r.error,
                                              r.created_at, r.completed_at
                                         from public.workflow_runs r where r.organisation_id = p_org
                                        order by r.created_at desc limit v_cap) x), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(x order by x.created_at desc)
                         from (select k.id, k.workflow_run_id, k.tender_id, k.type, k.title, k.status, k.input, k.output, k.error,
                                      k.created_at, k.completed_at
                                 from public.tasks k where k.organisation_id = p_org
                                order by k.created_at desc limit v_cap) x), '[]'::jsonb),
    'approvals', coalesce((select jsonb_agg(x order by x.requested_at desc)
                             from (select a.id, a.tender_id, a.type, a.summary, a.risk_level, a.status, a.decided_by, a.comments,
                                          a.requested_at, a.expires_at, a.approved_at, a.rejected_at
                                     from public.approvals a where a.organisation_id = p_org
                                    order by a.requested_at desc limit v_cap) x), '[]'::jsonb),
    'submission_records', coalesce((select jsonb_agg(x order by x.created_at desc)
                                      from (select s.id, s.tender_id, s.approval_id, s.method, s.status, s.is_simulation, s.package_hash,
                                                   s.destination, s.external_reference, s.receipt, s.submitted_at, s.created_at
                                              from public.submission_records s where s.organisation_id = p_org
                                             order by s.created_at desc limit v_cap) x), '[]'::jsonb),
    'email_accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'user_id', a.user_id, 'provider', a.provider,
                                                                    'from_address', a.from_address, 'display_name', a.display_name,
                                                                    'smtp_host', a.smtp_host, 'smtp_port', a.smtp_port,
                                                                    'smtp_username', a.smtp_username, 'status', a.status,
                                                                    'last_used_at', a.last_used_at, 'created_at', a.created_at,
                                                                    'revoked_at', a.revoked_at) order by a.created_at)
                                  from public.email_accounts a where a.organisation_id = p_org), '[]'::jsonb),
    'email_messages', coalesce((select jsonb_agg(x order by x.created_at desc)
                                  from (select e.id, e.tender_id, e.sent_by, e.from_address, e.to_address, e.subject, e.attachments, e.status,
                                               e.error, e.created_at
                                          from public.email_messages e where e.organisation_id = p_org
                                         order by e.created_at desc limit v_cap) x), '[]'::jsonb),
    'discovery_runs', coalesce((select jsonb_agg(x order by x.created_at desc)
                                  from (select d.id, d.provinces, d.methods, d.trigger, d.status, d.scanned, d.matched, d.created_tenders,
                                               d.started_workflows, d.error, d.requested_by, d.created_at, d.completed_at
                                          from public.discovery_runs d where d.organisation_id = p_org
                                         order by d.created_at desc limit v_cap) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(x order by x.created_at desc)
                          from (select v.id, v.event_type, v.severity, v.summary, v.tender_id, v.actor_user_id, v.payload, v.created_at
                                  from public.agent_events v where v.organisation_id = p_org
                                 order by v.created_at desc limit v_cap) x), '[]'::jsonb),
    'audit_log', coalesce((select jsonb_agg(x order by x.created_at desc)
                             from (select l.id, l.actor_type, l.actor_user_id, l.action, l.resource_type, l.resource_id, l.ip, l.user_agent,
                                          l.metadata, l.created_at
                                     from public.audit_logs l where l.organisation_id = p_org
                                    order by l.created_at desc limit v_cap) x), '[]'::jsonb),
    'limits', jsonb_build_object('rows_per_list', v_cap)
  ) into v_out;

  insert into public.audit_logs (organisation_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  values (p_org, 'system', p_actor, 'popia.organisation_exported', 'organisation', p_org::text, '{}'::jsonb);
  return v_out;
end;
$$;

revoke execute on function public.export_user_data(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.export_organisation_data(uuid, uuid) from public, anon, authenticated;
grant execute on function public.export_user_data(uuid, uuid) to service_role;
grant execute on function public.export_organisation_data(uuid, uuid) to service_role;
