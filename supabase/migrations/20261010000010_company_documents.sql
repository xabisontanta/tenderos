-- Company document vault. Files live in the private Storage bucket
-- company-documents under <organisation_id>/<uuid>/<file name>; this table
-- holds the metadata the agents read. Agents only see documents whose data
-- category they are granted (AGENTS.md section 4).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-documents', 'company-documents', false, 20971520, array[
  'application/pdf', 'image/png', 'image/jpeg', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
on conflict (id) do nothing;

-- Mirrors DOCUMENT_TYPES in lib/domain/documents.ts.
create or replace function private.document_category(p_type text)
returns public.data_category
language sql
immutable
set search_path = ''
as $$
  select (case p_type
    when 'cipc_registration' then 'COMPANY_PROFILE'
    when 'csd_registration' then 'COMPANY_PROFILE'
    when 'tax_compliance' then 'TAX'
    when 'bbbee' then 'BBBEE'
    when 'sbd_declarations' then 'COMPANY_PROFILE'
    when 'cidb_grading' then 'CERTIFICATIONS'
    when 'coida' then 'CERTIFICATIONS'
    when 'insurance' then 'INSURANCE'
    when 'company_profile_doc' then 'COMPANY_CAPABILITIES'
    when 'project_references' then 'PROJECT_REFERENCES'
    when 'financial_statements' then 'FINANCIAL'
    when 'bank_confirmation' then 'BANKING'
    when 'director_ids' then 'DIRECTOR_PERSONAL'
    when 'proof_of_address' then 'PROOF_OF_ADDRESS'
    when 'other' then 'COMPANY_PROFILE'
  end)::public.data_category;
$$;

create table public.company_documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  doc_type text not null check (doc_type in (
    'cipc_registration',
    'csd_registration',
    'tax_compliance',
    'bbbee',
    'sbd_declarations',
    'cidb_grading',
    'coida',
    'insurance',
    'company_profile_doc',
    'project_references',
    'financial_statements',
    'bank_confirmation',
    'director_ids',
    'proof_of_address',
    'other')),
  data_category public.data_category not null,
  title text not null check (char_length(title) between 2 and 200),
  file_name text not null check (char_length(file_name) between 1 and 255),
  storage_path text not null unique check (char_length(storage_path) <= 500),
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes > 0),
  expires_at date,
  verified boolean not null default false,
  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check (data_category = private.document_category(doc_type))
);
create index company_documents_org_idx on public.company_documents (organisation_id, doc_type) where archived_at is null;

alter table public.company_documents enable row level security;
create policy "members read company documents" on public.company_documents
  for select to authenticated using (private.is_org_member(organisation_id));
revoke all on public.company_documents from anon;
revoke insert, update, delete, truncate on public.company_documents from authenticated;

-- First path segment of a storage object name as an organisation id, or null.
create or replace function private.storage_path_org(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;
grant execute on function private.storage_path_org(text) to authenticated, service_role;

create policy "members read company document files" on storage.objects
  for select to authenticated
  using (bucket_id = 'company-documents' and private.is_org_member(private.storage_path_org(name)));
create policy "operators upload company document files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'company-documents'
              and private.has_org_role(private.storage_path_org(name), array['owner', 'admin', 'operator']::public.org_role[]));

-- Records an uploaded file. Owners and admins attest the document is current
-- and correct when they upload it; an operator's upload waits for an owner or
-- admin to verify it before compliance counts it.
create or replace function public.register_company_document(
  p_org uuid, p_doc_type text, p_title text, p_path text, p_expires_at date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_obj record;
  v_admin boolean;
  v_id uuid;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
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
$$;

create or replace function public.verify_company_document(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organisation_id into v_org from public.company_documents where id = p_id and archived_at is null;
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can verify documents' using errcode = 'insufficient_privilege';
  end if;
  update public.company_documents set verified = true, verified_by = auth.uid(), verified_at = now() where id = p_id;
  perform private.write_audit(v_org, 'document.verified', 'company_document', p_id::text, '{}'::jsonb);
end;
$$;

create or replace function public.archive_company_document(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organisation_id into v_org from public.company_documents where id = p_id and archived_at is null;
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can remove documents' using errcode = 'insufficient_privilege';
  end if;
  update public.company_documents set archived_at = now() where id = p_id;
  perform private.write_audit(v_org, 'document.archived', 'company_document', p_id::text, '{}'::jsonb);
end;
$$;

-- A new or verified document can unblock bids stopped at compliance.
create trigger company_documents_recheck after insert or update of verified on public.company_documents
  for each row when (new.verified and new.archived_at is null)
  execute function private.recheck_blocked_compliance();

revoke all on function private.document_category(text) from public;
grant execute on function private.document_category(text) to authenticated, service_role;
revoke execute on function public.register_company_document(uuid, text, text, text, date) from public, anon;
revoke execute on function public.verify_company_document(uuid) from public, anon;
revoke execute on function public.archive_company_document(uuid) from public, anon;
grant execute on function public.register_company_document(uuid, text, text, text, date) to authenticated;
grant execute on function public.verify_company_document(uuid) to authenticated;
grant execute on function public.archive_company_document(uuid) to authenticated;
