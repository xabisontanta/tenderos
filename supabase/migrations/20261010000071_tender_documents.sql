-- Tender documents: the files a tender's portal lists, fetched by the worker so the Tender Analyst has something to read.
--
--   * Files live in the private Storage bucket tender-documents under <organisation_id>/<tender_id>/<sha256>.pdf, the same
--     shape as the company-documents vault: members of the organisation may read them (through a function that only
--     lets a stored, downloaded file through), nobody can write from a browser, and the service role (the worker) does
--     the writing. Only PDFs are stored: they are the only type the AI reads in this release.
--   * public.tender_documents is one row per document the portal lists (tenders.documents), with its fetch status:
--       PENDING     waiting to be fetched (or to be tried again)
--       DOWNLOADED  fetched, checked against its file type, stored
--       FAILED      could not be fetched or is not what its name says; a person can retry
--       UNSUPPORTED real but not read yet (Word, Excel, zip, other types, password-protected PDFs, duplicates)
--       TOO_LARGE   over the size limit
--   * private.queue_tender_documents lists a real tender's documents as PENDING rows and queues the worker job
--     tender.documents.fetch. Discovery calls it when a tender is stored or refreshed, and only for organisations that
--     have AI assistance on (the files are of no use without it); fetch_tender_documents is the "Fetch documents" button
--     and "Retry", for owners, admins and operators, rate limited, audited, and behind the second factor when required.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tender-documents', 'tender-documents', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;

create table public.tender_documents (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  tender_id uuid not null,
  source_url text not null check (char_length(source_url) <= 2000 and source_url ~ '^https://'),
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text check (mime_type is null or char_length(mime_type) <= 150),
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  page_count integer check (page_count is null or page_count >= 0),
  storage_path text unique check (storage_path is null or char_length(storage_path) <= 500),
  status text not null default 'PENDING' check (status in ('PENDING', 'DOWNLOADED', 'FAILED', 'UNSUPPORTED', 'TOO_LARGE')),
  error text check (error is null or char_length(error) <= 500),
  attempts integer not null default 0 check (attempts >= 0),
  fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade,
  unique (tender_id, source_url),
  unique (tender_id, sha256),
  -- A file is in Storage exactly when it was downloaded, and then its hash and size are known.
  check ((status = 'DOWNLOADED') = (storage_path is not null)),
  check (status <> 'DOWNLOADED' or (sha256 is not null and size_bytes is not null))
);
create index tender_documents_tender_idx on public.tender_documents (tender_id, status);
create trigger tender_documents_updated_at before update on public.tender_documents
  for each row execute function private.set_updated_at();

alter table public.tender_documents enable row level security;
create policy "members read tender documents" on public.tender_documents
  for select to authenticated using (private.is_org_member(organisation_id));
revoke all on public.tender_documents from anon;
revoke insert, update, delete, truncate on public.tender_documents from authenticated;

-- A file in the bucket is readable only while its row says it was downloaded, and only by a member of its organisation.
create or replace function private.can_read_tender_document_file(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tender_documents d
     where d.storage_path = p_name and d.status = 'DOWNLOADED' and private.is_org_member(d.organisation_id));
$$;
revoke all on function private.can_read_tender_document_file(text) from public;
grant execute on function private.can_read_tender_document_file(text) to authenticated, service_role;

create policy "members read tender document files" on storage.objects
  for select to authenticated
  using (bucket_id = 'tender-documents' and private.can_read_tender_document_file(name));
-- No insert, update or delete policy: browsers cannot write to this bucket.

-- Lists the documents a real tender's portal shows as PENDING rows (new ones only) and queues the fetch job. Returns how many
-- rows are waiting. Without p_force it does nothing for an organisation that has not switched AI assistance on.
create or replace function private.queue_tender_documents(p_tender uuid, p_force boolean default false)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_sim boolean;
  v_docs jsonb;
  v_waiting integer;
begin
  select t.organisation_id, t.is_simulation, t.documents into v_org, v_sim, v_docs from public.tenders t where t.id = p_tender;
  if v_org is null or v_sim then
    return 0;
  end if;
  if not p_force and not exists (select 1 from public.system_settings s where s.organisation_id = v_org and s.ai_enabled) then
    return 0;
  end if;

  insert into public.tender_documents (organisation_id, tender_id, source_url, file_name)
  select v_org, p_tender, d.item ->> 'url',
         left(coalesce(nullif(trim(regexp_replace(coalesce(d.item ->> 'name', ''), '[\x01-\x1f\x7f]', '', 'g')), ''), 'document'), 255)
    from jsonb_array_elements(v_docs) with ordinality as d(item, n)
   where jsonb_typeof(d.item) = 'object' and (d.item ->> 'url') ~ '^https://' and char_length(d.item ->> 'url') <= 2000 and d.n <= 50
  on conflict (tender_id, source_url) do nothing;

  select count(*) into v_waiting from public.tender_documents where tender_id = p_tender and status = 'PENDING';
  if v_waiting > 0 then
    perform private.enqueue_job(v_org, 'tender.documents.fetch', jsonb_build_object('tender_id', p_tender), 'tender.documents.fetch:' || p_tender::text);
  end if;
  return v_waiting;
end;
$$;
revoke all on function private.queue_tender_documents(uuid, boolean) from public, anon, authenticated;
grant execute on function private.queue_tender_documents(uuid, boolean) to service_role;

-- "Fetch documents" and "Retry" on the tender page. Documents that failed are put back to PENDING (one of them, or all);
-- new documents the portal lists are added; the job is queued. Returns how many documents are waiting to be fetched.
create or replace function public.fetch_tender_documents(p_tender_id uuid, p_document_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_sim boolean;
  v_reset integer;
  v_waiting integer;
begin
  perform public.hit_rate_limit('tender.documents_fetch', 30, 3600);
  select t.organisation_id, t.is_simulation into v_org, v_sim from public.tenders t where t.id = p_tender_id;
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Not permitted' using errcode = 'insufficient_privilege';
  end if;
  perform private.require_aal2(v_org);
  if v_sim then
    raise exception 'Simulated tenders have no documents to fetch' using errcode = 'check_violation';
  end if;
  if p_document_id is not null and not exists (select 1 from public.tender_documents d where d.id = p_document_id and d.tender_id = p_tender_id) then
    raise exception 'That document does not belong to this tender' using errcode = 'check_violation';
  end if;

  update public.tender_documents d
     set status = 'PENDING', attempts = 0, error = null
   where d.tender_id = p_tender_id and d.status = 'FAILED' and (p_document_id is null or d.id = p_document_id);
  get diagnostics v_reset = row_count;

  v_waiting := private.queue_tender_documents(p_tender_id, true);
  perform private.write_audit(v_org, 'tender.documents_fetch_requested', 'tender', p_tender_id::text,
    jsonb_build_object('retried', v_reset, 'waiting', v_waiting, 'document_id', p_document_id));
  return v_waiting;
end;
$$;
revoke execute on function public.fetch_tender_documents(uuid, uuid) from public, anon;
grant execute on function public.fetch_tender_documents(uuid, uuid) to authenticated;
