-- Consent to the terms of service and privacy notice (docs/auth.md).
--
-- legal_documents lists every published version of each document and marks the
-- one in force. legal_acceptances records who accepted which version and when.
-- Neither can be written by browsers: the sign-up trigger and accept_legal are
-- the only writers, and both check the version against the one in force.
--
-- Versions are named in lib/legal/versions.ts as well. Publishing a new version
-- means a migration like this one (insert the new row, flip is_current) and a
-- change to that file; the legal integration test fails if they drift apart.

create table public.legal_documents (
  kind text not null check (kind in ('terms', 'privacy')),
  version text not null check (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  is_current boolean not null default false,
  published_at timestamptz not null default now(),
  primary key (kind, version)
);
create unique index legal_documents_current_uq on public.legal_documents (kind) where is_current;

-- Placeholder drafts, pending review by a South African attorney. Production
-- needs attorney-reviewed text published as a new version (docs/legal).
insert into public.legal_documents (kind, version, is_current)
values ('terms', '2026-10-11-draft', true), ('privacy', '2026-10-11-draft', true);

create table public.legal_acceptances (
  id bigint generated always as identity primary key,
  -- Deleting the account deletes its consent records. Whether proof of consent
  -- has to outlive the account is an open point for the attorney
  -- (docs/legal/popia-overview.md, open point 6).
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  version text not null,
  accepted_at timestamptz not null default now(),
  -- HMAC of the visitor's address, never the address itself; null when unknown.
  ip_hmac text check (ip_hmac is null or ip_hmac ~ '^[0-9a-f]{64}$'),
  constraint legal_acceptances_document_fk foreign key (kind, version) references public.legal_documents (kind, version),
  constraint legal_acceptances_once_uq unique (user_id, kind, version)
);

alter table public.legal_documents enable row level security;
alter table public.legal_acceptances enable row level security;

-- The documents are public: they are linked from the sign-up form.
create policy "anyone reads legal documents" on public.legal_documents
  for select to anon, authenticated using (true);
create policy "users read their own acceptances" on public.legal_acceptances
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.legal_documents, public.legal_acceptances from anon, authenticated;
grant select on public.legal_documents to anon, authenticated;
grant select on public.legal_acceptances to authenticated;

-- ---------------------------------------------------------------------------
-- Sign-up: private.handle_new_user, re-created whole (it was defined in
-- migration 001 and nothing has changed it since). The profile insert is
-- unchanged. New: when the sign-up metadata names the versions now in force,
-- record the acceptance. Consent bookkeeping must never block an account, so
-- any failure there is logged as a warning and swallowed; a user without a
-- record is sent to /legal/accept the first time they use the app.
-- ---------------------------------------------------------------------------
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_terms text := new.raw_user_meta_data ->> 'terms_version';
  v_privacy text := new.raw_user_meta_data ->> 'privacy_version';
  v_ip text := new.raw_user_meta_data ->> 'consent_ip_hmac';
begin
  insert into public.profiles (id, full_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;

  begin
    if v_terms is not null and v_privacy is not null
       and exists (select 1 from public.legal_documents d where d.kind = 'terms' and d.version = v_terms and d.is_current)
       and exists (select 1 from public.legal_documents d where d.kind = 'privacy' and d.version = v_privacy and d.is_current) then
      insert into public.legal_acceptances (user_id, kind, version, ip_hmac)
      values (new.id, 'terms', v_terms, case when v_ip ~ '^[0-9a-f]{64}$' then v_ip end),
             (new.id, 'privacy', v_privacy, case when v_ip ~ '^[0-9a-f]{64}$' then v_ip end)
      on conflict (user_id, kind, version) do nothing;
    end if;
  exception when others then
    raise warning 'legal acceptance not recorded for new user: %', sqlerrm;
  end;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Later: a user who has not accepted what is now in force (signed up through
-- the API without the consent fields, or a new version was published).
-- ---------------------------------------------------------------------------
create or replace function public.pending_legal_acceptances()
returns table (kind text, version text)
language sql
stable
set search_path = ''
as $$
  select d.kind, d.version
    from public.legal_documents d
   where d.is_current
     and not exists (
       select 1 from public.legal_acceptances a
        where a.user_id = (select auth.uid()) and a.kind = d.kind and a.version = d.version)
   order by d.kind;
$$;
revoke execute on function public.pending_legal_acceptances() from public, anon;
grant execute on function public.pending_legal_acceptances() to authenticated;

create or replace function public.accept_legal(p_terms_version text, p_privacy_version text, p_ip_hmac text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ip text := case when p_ip_hmac ~ '^[0-9a-f]{64}$' then p_ip_hmac end;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('legal.accept', 10, 3600);
  if not exists (select 1 from public.legal_documents d where d.kind = 'terms' and d.version = p_terms_version and d.is_current)
     or not exists (select 1 from public.legal_documents d where d.kind = 'privacy' and d.version = p_privacy_version and d.is_current) then
    raise exception 'These documents have been updated. Reload the page to read the new versions.' using errcode = 'check_violation';
  end if;
  insert into public.legal_acceptances (user_id, kind, version, ip_hmac)
  values (auth.uid(), 'terms', p_terms_version, v_ip), (auth.uid(), 'privacy', p_privacy_version, v_ip)
  on conflict (user_id, kind, version) do nothing;
end;
$$;
revoke execute on function public.accept_legal(text, text, text) from public, anon;
grant execute on function public.accept_legal(text, text, text) to authenticated;
