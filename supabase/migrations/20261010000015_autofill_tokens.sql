-- Pairing codes for the TenderOS browser helper ("fill, you submit").
--
-- A member creates a pairing code on Settings -> Browser helper and pastes it
-- into the browser extension. With it, the extension reads the company
-- profile, the verified company documents and the bids awaiting delivery
-- through /api/autofill, and fills a tender portal form in that person's own
-- browser. The helper is a person's tool, not an agent: it fills fields and
-- attaches files, and the person checks everything and submits it
-- themselves. It never submits, never ticks declarations, never enters
-- prices and never signs.
--
-- Only the SHA-256 hash of a code is stored. Browsers never read the hash;
-- only the server (service role) resolves a code to its member, and only
-- while the member still belongs to the organisation as an owner, admin or
-- operator. Removing the member deletes their codes.

create table public.autofill_tokens (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 days',
  revoked_at timestamptz,
  check (expires_at > created_at),
  foreign key (organisation_id, user_id) references public.organisation_members (organisation_id, user_id) on delete cascade
);
create index autofill_tokens_member_idx on public.autofill_tokens (organisation_id, user_id) where revoked_at is null;

alter table public.autofill_tokens enable row level security;
create policy "members read own autofill tokens" on public.autofill_tokens
  for select to authenticated
  using (user_id = (select auth.uid()) and private.is_org_member(organisation_id));
revoke all on public.autofill_tokens from anon, authenticated;
-- token_hash stays server-only.
grant select (id, organisation_id, user_id, label, created_at, last_used_at, expires_at, revoked_at)
  on public.autofill_tokens to authenticated;

-- ---------------------------------------------------------------------------
-- Create / revoke (called with the member's own session)
-- ---------------------------------------------------------------------------

-- Returns the plaintext code once. It is never stored or shown again.
create or replace function public.create_autofill_token(p_org uuid, p_label text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_label text := coalesce(nullif(left(trim(p_label), 60), ''), 'Browser helper');
  v_token text;
  v_id uuid;
  v_expires timestamptz;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'operator']::public.org_role[]) then
    raise exception 'Only owners, admins and operators can pair the browser helper' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('autofill.token_create', 10, 3600);
  -- Serialise concurrent requests from the same member so the cap holds.
  perform 1 from public.organisation_members where organisation_id = p_org and user_id = auth.uid() for update;
  if (select count(*) from public.autofill_tokens
       where organisation_id = p_org and user_id = auth.uid() and revoked_at is null and expires_at > now()) >= 5 then
    raise exception 'You already have 5 active pairing codes; revoke one first' using errcode = 'check_violation';
  end if;
  v_token := 'tos_' || encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.autofill_tokens (organisation_id, user_id, label, token_hash)
  values (p_org, auth.uid(), v_label, encode(extensions.digest(v_token, 'sha256'), 'hex'))
  returning id, expires_at into v_id, v_expires;
  perform private.write_audit(p_org, 'autofill.token_created', 'autofill_token', v_id::text,
    jsonb_build_object('label', v_label, 'expires_at', v_expires));
  return v_token;
end;
$$;

-- The member who created a code, or an owner/admin, can revoke it.
create or replace function public.revoke_autofill_token(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tok public.autofill_tokens;
begin
  select * into v_tok from public.autofill_tokens where id = p_id and revoked_at is null for update;
  if v_tok.id is null
     or not ((v_tok.user_id = auth.uid() and private.is_org_member(v_tok.organisation_id))
             or private.has_org_role(v_tok.organisation_id, array['owner', 'admin']::public.org_role[])) then
    raise exception 'Pairing code not found' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('autofill.token_revoke', 30, 3600);
  update public.autofill_tokens set revoked_at = now() where id = p_id;
  perform private.write_audit(v_tok.organisation_id, 'autofill.token_revoked', 'autofill_token', p_id::text,
    jsonb_build_object('label', v_tok.label, 'owner', v_tok.user_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Server only (service role): resolving a code, rate limits, documents
-- ---------------------------------------------------------------------------

-- The member behind a live code, with their current role. Revoked or expired
-- codes, departed members and members demoted to viewer resolve to nothing.
create or replace function public.resolve_autofill_token(p_hash text)
returns table (token_id uuid, organisation_id uuid, user_id uuid, role public.org_role)
language sql
volatile
security definer
set search_path = ''
as $$
  update public.autofill_tokens t
     set last_used_at = now()
    from public.organisation_members m
   where p_hash ~ '^[a-f0-9]{64}$'
     and t.token_hash = p_hash
     and t.revoked_at is null
     and t.expires_at > now()
     and m.organisation_id = t.organisation_id
     and m.user_id = t.user_id
     and m.role in ('owner', 'admin', 'operator')
  returning t.id, t.organisation_id, t.user_id, m.role;
$$;

-- Sibling of hit_rate_limit for server code that authenticates callers itself
-- (e.g. a pairing code). The key names the subject explicitly, such as
-- 'autofill_token:<id>', and never collides with a user's own limits.
create or replace function public.hit_rate_limit_key(p_key text, p_action text, p_max integer default 30, p_window_seconds integer default 60)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_key is null or p_key !~ '^[a-z][a-z0-9_]{2,30}:[A-Za-z0-9-]{1,64}$'
     or p_action is null or p_action !~ '^[a-z][a-z0-9_.]{2,60}$'
     or p_max not between 1 and 1000 or p_window_seconds not between 1 and 3600 then
    raise exception 'Invalid rate limit request' using errcode = 'check_violation';
  end if;
  perform private.check_rate_limit(p_key || ':' || p_action, p_max, make_interval(secs => p_window_seconds));
end;
$$;

-- Director IDs, bank letters and proof of address only reach owners and
-- admins (AGENTS.md section 4); every other category reaches operators too.
-- Same rule as private.can_read_document, which resolves the caller from the
-- session; the helper's requests run as the service role, so the role is passed.
create or replace function private.autofill_category_allowed(p_role public.org_role, p_category public.data_category)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_role in ('owner', 'admin') or p_category not in ('DIRECTOR_PERSONAL', 'BANKING', 'PROOF_OF_ADDRESS');
$$;

-- Documents the helper may attach for a live code: verified, not archived,
-- in date today (South African time), and in a category the member's
-- current role allows. Metadata only.
create or replace function public.autofill_documents(p_token_id uuid)
returns table (id uuid, doc_type text, title text, file_name text, mime_type text, size_bytes bigint, expires_at date, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.doc_type, d.title, d.file_name, d.mime_type, d.size_bytes, d.expires_at, d.created_at
    from public.autofill_tokens t
    join public.organisation_members m on m.organisation_id = t.organisation_id and m.user_id = t.user_id
    join public.company_documents d on d.organisation_id = t.organisation_id
   where t.id = p_token_id
     and t.revoked_at is null
     and t.expires_at > now()
     and m.role in ('owner', 'admin', 'operator')
     and d.verified
     and d.archived_at is null
     and (d.expires_at is null or d.expires_at >= (now() at time zone 'Africa/Johannesburg')::date)
     and private.autofill_category_allowed(m.role, d.data_category)
   order by d.doc_type, d.created_at desc;
$$;

-- Authorises one document download for a live code and records it in the
-- audit log as the member's own action. Returns nothing when not allowed.
create or replace function public.autofill_document_download(p_token_id uuid, p_document_id uuid)
returns table (storage_path text, file_name text, mime_type text, size_bytes bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_doc record;
begin
  select d.id, d.organisation_id, d.doc_type, d.storage_path, d.file_name, d.mime_type, d.size_bytes, t.user_id
    into v_doc
    from public.autofill_documents(p_token_id) a
    join public.company_documents d on d.id = a.id
    join public.autofill_tokens t on t.id = p_token_id
   where a.id = p_document_id;
  if v_doc.id is null then
    return;
  end if;
  insert into public.audit_logs (organisation_id, actor_type, actor_user_id, action, resource_type, resource_id, metadata)
  values (v_doc.organisation_id, 'user', v_doc.user_id, 'document.autofill_download', 'company_document', v_doc.id::text,
          jsonb_build_object('doc_type', v_doc.doc_type, 'via', 'browser_helper', 'autofill_token_id', p_token_id));
  return query select v_doc.storage_path, v_doc.file_name, v_doc.mime_type, v_doc.size_bytes;
end;
$$;

revoke all on function private.autofill_category_allowed(public.org_role, public.data_category) from public, anon, authenticated;
revoke execute on function public.create_autofill_token(uuid, text) from public, anon;
revoke execute on function public.revoke_autofill_token(uuid) from public, anon;
revoke execute on function public.resolve_autofill_token(text) from public, anon, authenticated;
revoke execute on function public.hit_rate_limit_key(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.autofill_documents(uuid) from public, anon, authenticated;
revoke execute on function public.autofill_document_download(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_autofill_token(uuid, text) to authenticated;
grant execute on function public.revoke_autofill_token(uuid) to authenticated;
grant execute on function public.resolve_autofill_token(text) to service_role;
grant execute on function public.hit_rate_limit_key(text, text, integer, integer) to service_role;
grant execute on function public.autofill_documents(uuid) to service_role;
grant execute on function public.autofill_document_download(uuid, uuid) to service_role;
