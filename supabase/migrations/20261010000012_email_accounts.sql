-- Mailboxes members connect so TenderOS can send email bids from their own
-- address: a Gmail account (OAuth, gmail.send scope) or any SMTP server on the
-- company's own domain. Credentials live encrypted in Supabase Vault; the
-- browser never sees them and only the server (service role) can read them.

create type public.email_provider as enum ('GMAIL', 'SMTP');

create table public.email_accounts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider public.email_provider not null,
  from_address text not null check (from_address ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' and char_length(from_address) <= 254),
  display_name text check (display_name is null or char_length(display_name) between 1 and 120),
  smtp_host text check (smtp_host is null or smtp_host ~* '^[a-z0-9.-]{1,253}$'),
  smtp_port integer check (smtp_port is null or smtp_port in (465, 587, 2525)),
  smtp_username text check (smtp_username is null or char_length(smtp_username) <= 254),
  secret_id uuid not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ERROR')),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check ((provider = 'SMTP') = (smtp_host is not null and smtp_port is not null and smtp_username is not null)),
  foreign key (organisation_id, user_id) references public.organisation_members (organisation_id, user_id) on delete cascade
);
create unique index email_accounts_active_uq on public.email_accounts (organisation_id, user_id, lower(from_address))
  where revoked_at is null;

alter table public.email_accounts enable row level security;
create policy "members read email accounts" on public.email_accounts
  for select to authenticated using (private.is_org_member(organisation_id));
revoke all on public.email_accounts from anon, authenticated;
-- secret_id stays server-only.
grant select (id, organisation_id, user_id, provider, from_address, display_name, smtp_host, smtp_port, smtp_username,
              status, last_error, last_used_at, created_at, revoked_at) on public.email_accounts to authenticated;

-- Every bid email TenderOS sends, for the audit trail and the tender page.
create table public.email_messages (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  email_account_id uuid not null references public.email_accounts (id) on delete restrict,
  tender_id uuid not null,
  submission_record_id uuid references public.submission_records (id) on delete set null,
  sent_by uuid not null references auth.users (id) on delete restrict,
  from_address text not null,
  to_address text not null check (char_length(to_address) <= 254),
  subject text not null check (char_length(subject) <= 300),
  attachments jsonb not null default '[]'::jsonb check (jsonb_typeof(attachments) = 'array'),
  status text not null check (status in ('SENT', 'FAILED')),
  provider_message_id text check (provider_message_id is null or char_length(provider_message_id) <= 300),
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now(),
  foreign key (organisation_id, tender_id) references public.tenders (organisation_id, id) on delete cascade
);
create index email_messages_tender_idx on public.email_messages (tender_id, created_at desc);
alter table public.email_messages enable row level security;
create policy "members read email messages" on public.email_messages
  for select to authenticated using (private.is_org_member(organisation_id));
revoke all on public.email_messages from anon, authenticated;
grant select on public.email_messages to authenticated;

-- ---------------------------------------------------------------------------
-- Connect / disconnect (called with the member's own session)
-- ---------------------------------------------------------------------------
create or replace function public.connect_email_account(
  p_org uuid, p_provider public.email_provider, p_from text, p_display_name text, p_secret text,
  p_smtp_host text default null, p_smtp_port integer default null, p_smtp_username text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_id uuid;
begin
  -- Only owners and admins deliver bids, so only they connect a sending mailbox.
  if not private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can connect a mailbox' using errcode = 'insufficient_privilege';
  end if;
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
$$;

-- The member who connected a mailbox, or an owner/admin, can disconnect it.
-- The credential is deleted from Vault at once.
create or replace function public.disconnect_email_account(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acc public.email_accounts;
begin
  select * into v_acc from public.email_accounts where id = p_id and revoked_at is null for update;
  if v_acc.id is null
     or not (v_acc.user_id = auth.uid() or private.has_org_role(v_acc.organisation_id, array['owner', 'admin']::public.org_role[])) then
    raise exception 'Mailbox not found' using errcode = 'insufficient_privilege';
  end if;
  update public.email_accounts set revoked_at = now() where id = p_id;
  delete from vault.secrets where id = v_acc.secret_id;
  perform private.write_audit(v_acc.organisation_id, 'email.disconnected', 'email_account', p_id::text, '{}'::jsonb);
end;
$$;

-- Server only: the decrypted credential, and only for the member who owns
-- the mailbox (the caller passes the user it has authenticated).
create or replace function public.email_account_credential(p_id uuid, p_user uuid)
returns table (provider public.email_provider, from_address text, display_name text, smtp_host text, smtp_port integer,
               smtp_username text, secret text, organisation_id uuid)
language sql
security definer
stable
set search_path = ''
as $$
  select a.provider, a.from_address, a.display_name, a.smtp_host, a.smtp_port, a.smtp_username, s.decrypted_secret, a.organisation_id
    from public.email_accounts a
    join vault.decrypted_secrets s on s.id = a.secret_id
   where a.id = p_id and a.user_id = p_user and a.revoked_at is null
     and exists (select 1 from public.organisation_members m where m.organisation_id = a.organisation_id and m.user_id = p_user);
$$;

-- Server only: Gmail access tokens expire hourly; a rotated refresh token is saved here.
create or replace function public.update_email_account_secret(p_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  select secret_id into v_secret from public.email_accounts where id = p_id and revoked_at is null;
  if v_secret is null then
    raise exception 'Mailbox not found' using errcode = 'check_violation';
  end if;
  perform vault.update_secret(v_secret, p_secret);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording that a person delivered an approved bid (by email, by hand or on
-- the portal). This closes the run the Submission Officer left waiting.
-- ---------------------------------------------------------------------------
create or replace function public.record_bid_delivery(p_submission_id uuid, p_reference text default null, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.submission_records;
  v_status public.tender_status;
begin
  select * into v_sub from public.submission_records where id = p_submission_id for update;
  if v_sub.id is null or not private.has_org_role(v_sub.organisation_id, array['owner', 'admin']::public.org_role[]) then
    raise exception 'Only owners and admins can record a bid delivery' using errcode = 'insufficient_privilege';
  end if;
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
$$;

revoke execute on function public.connect_email_account(uuid, public.email_provider, text, text, text, text, integer, text) from public, anon;
revoke execute on function public.disconnect_email_account(uuid) from public, anon;
revoke execute on function public.email_account_credential(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.update_email_account_secret(uuid, text) from public, anon, authenticated;
revoke execute on function public.record_bid_delivery(uuid, text, text) from public, anon;
grant execute on function public.connect_email_account(uuid, public.email_provider, text, text, text, text, integer, text) to authenticated;
grant execute on function public.disconnect_email_account(uuid) to authenticated;
grant execute on function public.email_account_credential(uuid, uuid) to service_role;
grant execute on function public.update_email_account_secret(uuid, text) to service_role;
grant execute on function public.record_bid_delivery(uuid, text, text) to authenticated;
