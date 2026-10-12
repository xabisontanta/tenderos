-- Member management: change a role, remove a member, list the team, and never lose the last owner.
--
-- Until now nobody could change a role or remove a member: the only way into organisation_members was
-- bootstrap_organisation (the creator becomes the owner) and a hand-run insert. Browsers have no write
-- access to the table, so everything here is a SECURITY DEFINER function that checks the caller itself.
--
-- Rules (AGENTS.md section 8, docs/security.md):
--   * Only owners and admins manage members. Anyone can remove themselves ("leave"), so a person who is
--     invited somewhere else is never stuck behind one organisation.
--   * Only owners can make someone an owner, change an owner, or make someone an admin. Admins cannot touch
--     owners. Handing out admin is the owner's decision because inviting an admin is too (migration 061).
--   * An organisation always keeps at least one owner. The functions check it under a row lock, and a trigger
--     enforces it for every other path, so two owners demoting each other at once cannot leave none.
--   * Ownership is transferred with change_member_role: make the new owner an owner, then step down.
--   * Removing a member revokes their browser pairing codes and disconnects their mailboxes (the credential in
--     Vault goes with the mailbox row), and both calls are rate limited and audited.

-- ---------------------------------------------------------------------------
-- 1. The last-owner guard
-- ---------------------------------------------------------------------------
-- Fires on a role change away from owner and on deleting an owner. It locks the other owners' rows (in id
-- order, so two callers cannot deadlock each other) and refuses when none is left. Two cases pass:
--   * the organisation row is already gone (deleting an organisation cascades to its members);
--   * app.erasure is on (erase_user and erase_organisation, which check for themselves: erase_user refuses
--     the only owner, and erasing an organisation removes every member on purpose).
create or replace function private.guard_last_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if current_setting('app.erasure', true) = 'on' or old.role <> 'owner' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.role = 'owner' then
    return new;
  end if;
  if not exists (select 1 from public.organisations o where o.id = old.organisation_id) then
    return coalesce(new, old);
  end if;
  perform 1 from public.organisation_members m
   where m.organisation_id = old.organisation_id and m.role = 'owner' and m.user_id <> old.user_id
   order by m.user_id
   for update;
  if not found then
    raise exception 'An organisation must keep at least one owner. Make someone else an owner first.' using errcode = 'check_violation';
  end if;
  return coalesce(new, old);
end;
$$;
revoke all on function private.guard_last_owner() from public, anon, authenticated;

create trigger organisation_members_keep_owner
  before update of role or delete on public.organisation_members
  for each row execute function private.guard_last_owner();

-- ---------------------------------------------------------------------------
-- 2. change_member_role
-- ---------------------------------------------------------------------------
create or replace function public.change_member_role(p_org uuid, p_user uuid, p_role public.org_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ---------------------------------------------------------------------------
-- 3. remove_member (also "leave": p_user = the caller)
-- ---------------------------------------------------------------------------
create or replace function public.remove_member(p_org uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
$$;

-- ---------------------------------------------------------------------------
-- 4. list_members
-- ---------------------------------------------------------------------------
-- The team with sign-in email addresses, which live in auth.users and are not otherwise readable. Owners and
-- admins see addresses; everyone else sees names and roles only. A non-member gets an empty list.
create or replace function public.list_members(p_org uuid)
returns table (user_id uuid, full_name text, email text, role public.org_role, joined_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id,
         p.full_name,
         case when private.has_org_role(p_org, array['owner', 'admin']::public.org_role[]) then u.email::text end,
         m.role,
         m.created_at
    from public.organisation_members m
    left join public.profiles p on p.id = m.user_id
    left join auth.users u on u.id = m.user_id
   where m.organisation_id = p_org
     and private.is_org_member(p_org)
   order by m.created_at, m.user_id;
$$;

revoke execute on function public.change_member_role(uuid, uuid, public.org_role) from public, anon;
revoke execute on function public.remove_member(uuid, uuid) from public, anon;
revoke execute on function public.list_members(uuid) from public, anon;
grant execute on function public.change_member_role(uuid, uuid, public.org_role) to authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;
grant execute on function public.list_members(uuid) to authenticated;
