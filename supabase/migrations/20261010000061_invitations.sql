-- Invitations: how people join an organisation that is not their own.
--
-- The product is sold to companies and to the accountants, auditors and tender consultants who work inside a
-- client's account. A person belongs to one organisation (migration 019), so they join the client's as a
-- member; an auditor or accountant gets the read-only `viewer` role.
--
--   * An owner or admin invites an address with a role (never owner). The database makes a random token,
--     stores only its SHA-256 hash, and hands the plaintext back once, to be put in the invitation email.
--   * Only owners invite admins. Invitations expire after seven days, at most 50 can be pending per
--     organisation, each person can send 20 an hour, and any one address receives at most 5 a day from anywhere.
--   * accept_invitation needs the caller's CONFIRMED sign-in address to equal the invited one, takes the same
--     per-user advisory lock as bootstrap_organisation, and relies on the one-organisation-per-user index: a
--     person who already belongs elsewhere gets a plain refusal telling them to leave first.
--   * Nothing here tells anyone whether an address has an account.
--
-- The table holds an invitee's email address, which is personal data: it is deleted with the account it was
-- addressed to (trigger on auth.users), purged 30 days after it ended, part of both exports, and removed with
-- the organisation. The audit rows name the invitation and the role, never the address.

create table public.organisation_invitations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations (id) on delete cascade,
  email text not null check (email = lower(email) and char_length(email) <= 254 and email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  role public.org_role not null check (role <> 'owner'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  invited_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  check (expires_at > created_at),
  check (accepted_at is null or revoked_at is null)
);

-- One live invitation per address and organisation. "Live" cannot include the expiry (now() is not immutable),
-- so create_invitation retires an expired one before it issues the next.
create unique index organisation_invitations_pending_uq on public.organisation_invitations (organisation_id, lower(email))
  where accepted_at is null and revoked_at is null;
create index organisation_invitations_org_idx on public.organisation_invitations (organisation_id, created_at desc);
create index organisation_invitations_email_idx on public.organisation_invitations (lower(email));
create index organisation_invitations_invited_by_idx on public.organisation_invitations (invited_by) where invited_by is not null;
create index organisation_invitations_accepted_by_idx on public.organisation_invitations (accepted_by) where accepted_by is not null;

alter table public.organisation_invitations enable row level security;
create policy "owners and admins read invitations" on public.organisation_invitations
  for select to authenticated
  using (private.has_org_role(organisation_id, array['owner', 'admin']::public.org_role[]));
revoke all on public.organisation_invitations from anon, authenticated;
-- token_hash stays server-only.
grant select (id, organisation_id, email, role, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at)
  on public.organisation_invitations to authenticated;

create or replace function private.invitation_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;
revoke all on function private.invitation_token_hash(text) from public, anon, authenticated;

-- Each address can be written to at most five times a day by anyone, so invitations cannot be used to flood
-- an inbox. The key is a hash: the address itself is never stored in the counter.
create or replace function private.limit_invitee(p_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.check_rate_limit('invitee:' || encode(extensions.digest(lower(p_email), 'sha256'), 'hex'), 5, interval '1 day');
end;
$$;
revoke all on function private.limit_invitee(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- create_invitation
-- ---------------------------------------------------------------------------
create or replace function public.create_invitation(p_org uuid, p_email text, p_role public.org_role)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ---------------------------------------------------------------------------
-- resend_invitation: a new token and a fresh week. The old link stops working.
-- ---------------------------------------------------------------------------
create or replace function public.resend_invitation(p_id uuid)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ---------------------------------------------------------------------------
-- revoke_invitation
-- ---------------------------------------------------------------------------
create or replace function public.revoke_invitation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
  perform public.hit_rate_limit('invitation.revoke', 60, 3600);
  if v_inv.accepted_at is not null or v_inv.revoked_at is not null then
    raise exception 'That invitation was already used or revoked' using errcode = 'check_violation';
  end if;
  update public.organisation_invitations i set revoked_at = now() where i.id = v_inv.id;
  perform private.write_audit(v_inv.organisation_id, 'invitation.revoked', 'invitation', v_inv.id::text, jsonb_build_object('role', v_inv.role));
end;
$$;

-- ---------------------------------------------------------------------------
-- accept_invitation
-- ---------------------------------------------------------------------------
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_inv public.organisation_invitations;
  v_email text;
  v_confirmed timestamptz;
  v_home uuid;
  c_invalid constant text := 'This invitation is no longer valid. Ask the person who invited you to send a new one.';
  c_elsewhere constant text :=
    'You already belong to another organisation. Leave it first (Settings, Team, Leave), then open the invitation link again.';
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = 'insufficient_privilege';
  end if;
  perform public.hit_rate_limit('invitation.accept', 10, 3600);
  -- The same lock bootstrap_organisation takes, so creating an organisation and joining one cannot interleave.
  perform pg_advisory_xact_lock(hashtextextended('tenderos.bootstrap:' || v_user::text, 0));

  if p_token is null or p_token !~ '^tinv_[a-f0-9]{64}$' then
    raise exception '%', c_invalid using errcode = 'check_violation';
  end if;
  select * into v_inv from public.organisation_invitations i where i.token_hash = private.invitation_token_hash(p_token) for update;
  if v_inv.id is null then
    raise exception '%', c_invalid using errcode = 'check_violation';
  end if;
  if v_inv.accepted_at is not null then
    -- The person who joined with it may open the link again.
    if v_inv.accepted_by = v_user and exists (select 1 from public.organisation_members m
                                               where m.organisation_id = v_inv.organisation_id and m.user_id = v_user) then
      return v_inv.organisation_id;
    end if;
    raise exception '%', c_invalid using errcode = 'check_violation';
  end if;
  if v_inv.revoked_at is not null then
    raise exception '%', c_invalid using errcode = 'check_violation';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'This invitation has expired. Ask the person who invited you to send a new one.' using errcode = 'check_violation';
  end if;

  -- The address on the account must be confirmed and must be the invited one, in the database and in the
  -- session's own token (a token minted before an address change does not carry the new address).
  select u.email, u.email_confirmed_at into v_email, v_confirmed from auth.users u where u.id = v_user;
  if v_email is null or v_confirmed is null then
    raise exception 'Confirm your email address before accepting an invitation.' using errcode = 'check_violation';
  end if;
  if lower(v_email) <> v_inv.email or lower(coalesce(auth.jwt() ->> 'email', '')) <> v_inv.email then
    raise exception 'This invitation was sent to a different email address. Sign in with the address it was sent to.' using errcode = 'check_violation';
  end if;

  select m.organisation_id into v_home from public.organisation_members m where m.user_id = v_user;
  if v_home is not null then
    if v_home <> v_inv.organisation_id then
      raise exception '%', c_elsewhere using errcode = 'check_violation';
    end if;
    update public.organisation_invitations i set accepted_at = now(), accepted_by = v_user where i.id = v_inv.id;
    return v_inv.organisation_id;
  end if;

  begin
    insert into public.organisation_members (organisation_id, user_id, role) values (v_inv.organisation_id, v_user, v_inv.role);
  exception when unique_violation then
    raise exception '%', c_elsewhere using errcode = 'check_violation';
  end;
  update public.organisation_invitations i set accepted_at = now(), accepted_by = v_user where i.id = v_inv.id;
  perform private.write_audit(v_inv.organisation_id, 'invitation.accepted', 'invitation', v_inv.id::text, jsonb_build_object('role', v_inv.role));
  return v_inv.organisation_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- invitation_preview: server only. What the invite page may show before anyone has signed in.
-- ---------------------------------------------------------------------------
create or replace function public.invitation_preview(p_token text)
returns table (invitation_id uuid, organisation_id uuid, organisation_name text, role public.org_role, email text, expires_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.organisation_id, o.name, i.role, i.email, i.expires_at
    from public.organisation_invitations i
    join public.organisations o on o.id = i.organisation_id
   where p_token ~ '^tinv_[a-f0-9]{64}$'
     and i.token_hash = private.invitation_token_hash(p_token)
     and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
$$;

-- ---------------------------------------------------------------------------
-- Personal data
-- ---------------------------------------------------------------------------
-- An invitation addressed to someone goes when their account does (erase_user and a plain account deletion
-- both end here). Invitations a person sent stay with the organisation, without their id (on delete set null).
create or replace function private.delete_invitations_for_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.email is not null then
    delete from public.organisation_invitations i where lower(i.email) = lower(old.email);
  end if;
  return old;
end;
$$;
revoke all on function private.delete_invitations_for_user() from public, anon, authenticated;
create trigger on_auth_user_deleted_invitations before delete on auth.users
  for each row execute function private.delete_invitations_for_user();

-- Finished invitations are not kept: 30 days after one was accepted, revoked or expired, its row (and the
-- address in it) is deleted. The audit trail keeps that it happened.
create or replace function private.purge_invitations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.organisation_invitations i where coalesce(i.accepted_at, i.revoked_at, i.expires_at) < now() - interval '30 days';
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;
revoke all on function private.purge_invitations() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tenderos-purge-invitations', '40 3 * * *', 'select private.purge_invitations()');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.create_invitation(uuid, text, public.org_role) from public, anon;
revoke execute on function public.resend_invitation(uuid) from public, anon;
revoke execute on function public.revoke_invitation(uuid) from public, anon;
revoke execute on function public.accept_invitation(text) from public, anon;
revoke execute on function public.invitation_preview(text) from public, anon, authenticated;
grant execute on function public.create_invitation(uuid, text, public.org_role) to authenticated;
grant execute on function public.resend_invitation(uuid) to authenticated;
grant execute on function public.revoke_invitation(uuid) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
grant execute on function public.invitation_preview(text) to service_role;

-- ---------------------------------------------------------------------------
-- Exports (migration 052) gain the invitations. Each function below is the whole of its migration-052
-- definition with one section added; the token hash is never exported.
--   export_user_data: 'invitations_received' (invitations addressed to the person's sign-in address) and
--   'invitations_sent' (how many they sent).
--   export_organisation_data: 'invitations' (every invitation row the purge has not removed yet).
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
    'invitations_received', coalesce((select jsonb_agg(jsonb_build_object('organisation_id', i.organisation_id, 'organisation_name', o.name,
                                                                         'role', i.role, 'invited_at', i.created_at, 'expires_at', i.expires_at,
                                                                         'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at) order by i.created_at)
                                        from public.organisation_invitations i
                                        join public.organisations o on o.id = i.organisation_id
                                        join auth.users su on lower(su.email) = i.email
                                       where su.id = p_user_id), '[]'::jsonb),
    'invitations_sent', (select count(*) from public.organisation_invitations i where i.invited_by = p_user_id),
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
    'invitations', coalesce((select jsonb_agg(x order by x.created_at desc)
                               from (select i.id, i.email, i.role, i.invited_by, i.created_at, i.expires_at, i.accepted_at, i.accepted_by, i.revoked_at
                                       from public.organisation_invitations i where i.organisation_id = p_org
                                      order by i.created_at desc limit v_cap) x), '[]'::jsonb),
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
