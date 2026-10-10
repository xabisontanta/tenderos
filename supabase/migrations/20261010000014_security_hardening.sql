-- Security hardening from the production audit (docs/security.md).

-- ---------------------------------------------------------------------------
-- 1. Document files are readable only while the document is live, and the
--    most sensitive categories only by owners and admins. Downloads go through
--    document_download, which checks the same rules and writes an audit row;
--    the app then signs a 60-second, download-only URL.
-- ---------------------------------------------------------------------------
create or replace function private.can_read_document(p_org uuid, p_category public.data_category)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_org_member(p_org)
     and (p_category not in ('DIRECTOR_PERSONAL', 'BANKING', 'PROOF_OF_ADDRESS')
          or private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]));
$$;

create or replace function private.can_read_document_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.company_documents d
     where d.storage_path = p_name and d.archived_at is null
       and private.can_read_document(d.organisation_id, d.data_category));
$$;
revoke all on function private.can_read_document(uuid, public.data_category) from public;
revoke all on function private.can_read_document_file(text) from public;
grant execute on function private.can_read_document(uuid, public.data_category) to authenticated, service_role;
grant execute on function private.can_read_document_file(text) to authenticated, service_role;

drop policy "members read company document files" on storage.objects;
create policy "members read live company document files" on storage.objects
  for select to authenticated
  using (bucket_id = 'company-documents' and private.can_read_document_file(name));

create or replace function public.document_download(p_id uuid)
returns table (storage_path text, file_name text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_doc public.company_documents;
begin
  select * into v_doc from public.company_documents d where d.id = p_id and d.archived_at is null;
  if v_doc.id is null or not private.can_read_document(v_doc.organisation_id, v_doc.data_category) then
    raise exception 'Document not found' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('document.download', 120, 3600);
  perform private.write_audit(v_doc.organisation_id, 'document.downloaded', 'company_document', v_doc.id::text,
    jsonb_build_object('doc_type', v_doc.doc_type));
  return query select v_doc.storage_path, v_doc.file_name;
end;
$$;
revoke execute on function public.document_download(uuid) from public, anon;
grant execute on function public.document_download(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Rate limits inside the RPCs themselves, so calling them directly with a
--    session token is limited the same as going through the app. Each listed
--    function gets one line at the top of its body. The security integration
--    test checks every function still carries it; keep the line when you
--    replace one of these functions in a later migration.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in
    select * from (values
      ('public.start_tender_workflow', 'workflow.start', 20, 60),
      ('public.cancel_workflow', 'workflow.cancel', 20, 60),
      ('public.retry_task', 'task.retry', 30, 60),
      ('public.transition_tender', 'tender.transition', 30, 60),
      ('public.decide_approval', 'approval.decide', 30, 60),
      ('public.set_agent_control', 'agent.control', 20, 60),
      ('public.set_kill_switch', 'settings.kill_switch', 10, 60),
      ('public.set_watched_provinces', 'settings.update', 30, 60),
      ('public.set_watched_methods', 'settings.update', 30, 60),
      ('public.register_company_document', 'document.register', 60, 3600),
      ('public.verify_company_document', 'document.manage', 120, 3600),
      ('public.archive_company_document', 'document.manage', 120, 3600),
      ('public.disconnect_email_account', 'email.disconnect', 20, 3600)
    ) as t (fn, action, max_hits, window_seconds)
  loop
    select pg_get_functiondef(r.fn::regproc) into v_def;
    if position(format('hit_rate_limit(%L', r.action) in v_def) > 0 then
      continue;
    end if;
    v_new := regexp_replace(v_def, '\n\s*begin\s*\n',
      format(E'\nbegin\n  if auth.uid() is not null then\n    perform public.hit_rate_limit(%L, %s, %s);\n  end if;\n',
             r.action, r.max_hits, r.window_seconds), 'i');
    if v_new = v_def then
      raise exception 'Could not add a rate limit to %', r.fn;
    end if;
    execute v_new;
  end loop;
end;
$$;

-- Tenders are created by direct insert under RLS; limit that too. Worker and
-- discovery inserts have no session user and are not limited.
create or replace function private.limit_tender_creation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    perform public.hit_rate_limit('tender.create', 30, 60);
  end if;
  return new;
end;
$$;
create trigger tenders_rate_limit before insert on public.tenders
  for each row execute function private.limit_tender_creation();

-- ---------------------------------------------------------------------------
-- 3. A tender can only point at its own organisation's source.
-- ---------------------------------------------------------------------------
update public.tenders t set source_id = null
 where source_id is not null
   and not exists (select 1 from public.tender_sources s where s.id = t.source_id and s.organisation_id = t.organisation_id);
alter table public.tender_sources add constraint tender_sources_org_id_uq unique (organisation_id, id);
alter table public.tenders drop constraint tenders_source_id_fkey;
alter table public.tenders add constraint tenders_source_fkey foreign key (organisation_id, source_id)
  references public.tender_sources (organisation_id, id) on delete set null (source_id);

-- ---------------------------------------------------------------------------
-- 4. company_profiles.updated_by is always the signed-in user, never a value
--    the browser sends.
-- ---------------------------------------------------------------------------
create or replace function private.stamp_company_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.updated_by := old.updated_by;
  end if;
  return new;
end;
$$;
create trigger company_profiles_stamp before insert or update on public.company_profiles
  for each row execute function private.stamp_company_profile();

-- ---------------------------------------------------------------------------
-- 5. Profiles are created by the sign-up trigger and never deleted by users.
-- ---------------------------------------------------------------------------
revoke insert, delete, truncate, references, trigger on public.profiles from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 6. Worker heartbeats are shared by every tenant: expose only whether a
--    worker is alive, not its processing counts.
-- ---------------------------------------------------------------------------
drop policy "authenticated read heartbeats" on public.worker_heartbeats;
revoke all on public.worker_heartbeats from anon, authenticated;

create or replace function public.worker_health()
returns table (workers integer, last_seen_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select (count(*) filter (where h.last_seen_at > now() - interval '60 seconds'))::integer, max(h.last_seen_at)
    from public.worker_heartbeats h;
$$;
revoke execute on function public.worker_health() from public, anon;
grant execute on function public.worker_health() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Two concurrent sign-ups for the same user cannot both create an
--    organisation.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.bootstrap_organisation'::regproc);
  v_new text;
begin
  if position('pg_advisory_xact_lock' in v_def) > 0 then
    return;
  end if;
  v_new := regexp_replace(v_def, '\n\s*begin\s*\n',
    E'\nbegin\n  perform pg_advisory_xact_lock(hashtextextended(''tenderos.bootstrap:'' || p_user_id::text, 0));\n', 'i');
  if v_new = v_def then
    raise exception 'Could not lock bootstrap_organisation';
  end if;
  execute v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Approvals expire for real. decide_approval used to mark an expired
--    approval and then raise, which rolled the mark back. Now it only refuses;
--    a sweeper marks expired approvals every 15 minutes and hands them to the
--    engine, which stops the run (the closing date has passed).
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text := pg_get_functiondef('public.decide_approval'::regproc);
  v_new text;
begin
  v_new := replace(v_def, E'    update public.approvals set status = ''EXPIRED'' where id = v_a.id;\n', '');
  if v_new <> v_def then
    execute v_new;
  end if;
end;
$$;

create or replace function private.expire_approvals()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.approvals;
  v_n integer := 0;
begin
  for v_a in
    select * from public.approvals
     where status = 'PENDING' and expires_at is not null and expires_at < now()
     for update skip locked
  loop
    update public.approvals set status = 'EXPIRED' where id = v_a.id;
    perform private.emit_event(v_a.organisation_id, 'APPROVAL_EXPIRED',
      'Submission approval expired: the closing date passed before anyone decided',
      jsonb_build_object('approval_type', v_a.type, 'expired_at', v_a.expires_at),
      'WARNING', v_a.requested_by_agent_id, v_a.tender_id, v_a.task_id, v_a.workflow_run_id, null, v_a.id, null);
    perform private.write_audit(v_a.organisation_id, 'approval.expired', 'approval', v_a.id::text,
      jsonb_build_object('type', v_a.type));
    if v_a.workflow_run_id is not null then
      perform private.enqueue_job(v_a.organisation_id, 'approval.decided',
        jsonb_build_object('approval_id', v_a.id, 'workflow_run_id', v_a.workflow_run_id),
        'approval.decided:' || v_a.id);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke all on function private.expire_approvals() from public, anon, authenticated;

select cron.schedule('tenderos-expire-approvals', '*/15 * * * *', 'select private.expire_approvals()');
